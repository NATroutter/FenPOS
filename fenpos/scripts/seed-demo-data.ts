import "dotenv/config";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { createLocalAccountIssuer } from "better-auth";
import { PrismaClient } from "../generated/prisma/client";
import { PrismaClient as LogsPrismaClient } from "../generated/prisma-logs/client";
import { PrismaClient as MetricsPrismaClient } from "../generated/prisma-metrics/client";
import { hashPassword } from "../lib/auth/password";
import { generateToken, hashSecret } from "../lib/auth/secrets";
import { siblingDatabaseUrl } from "../lib/database-url";
import { HINT_LENGTH, KEY_PREFIX } from "../lib/keys/key-format";
import { LOG_SEVERITY } from "../lib/logs/log-sort";
import { addSample, emptyHistogram, serializeHistogram } from "../lib/metrics/histogram";
import { runMetricsRollup } from "../lib/metrics/rollup";

/**
 * Fills a development database with enough plausible data to see every screen populated.
 *
 * Building a panel against an empty database means every list is an empty state, every filter has
 * nothing to filter, and layout problems only appear on the day real data arrives. This produces
 * agents in different conditions, printers with different paper widths, keys with different
 * grants, 90 days of jobs and fleet history for the Statistics page's charts to draw, and two demo
 * accounts to sign in as.
 *
 * Usage:
 *   pnpm db:seed            # replace the demo data with a fresh set
 *   pnpm db:seed --clean    # remove it and stop
 *
 * **Everything it creates is named `demo-…`, and it only ever deletes rows with those names.**
 * That is what makes it safe to run against a database you have been working in: your own agents,
 * printers and keys are untouched, and re-running replaces the demo set rather than piling a
 * second copy on top of the first. The one exception is the metrics database's fleet-wide tables
 * (`fleet_samples`, `metric_api_hourly`, `metric_auth_hourly`, `metric_watermarks`), which carry no
 * per-agent or per-device column to scope a `demo-` match against — see the clean phase below.
 *
 * The data is generated from a fixed seed, so two runs produce the same jobs and the same log
 * lines. Screenshots taken a week apart stay comparable, and a layout bug you saw once can be
 * reproduced rather than hunted.
 *
 * **Seeded agents always show as offline in the panel.** Reachability is not a column — it is
 * whether the agent currently holds a WebSocket to this process, read from an in-memory registry.
 * Nothing written to the database can fake it. Everything else about an agent is real.
 *
 * Refuses to run against a production build unless `--force` is given, because the point of demo
 * data is that it is obviously not real, and a live install is where that stops being true.
 */

/** Marks every row this script owns. Cleanup matches on it, so nothing else can be caught. */
const PREFIX = "demo-";

/** Fixed so that two runs produce identical data. */
const RANDOM_SEED = 0x5eed;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * A small deterministic generator.
 *
 * `Math.random` would make every run different, which defeats comparing a screen against how it
 * looked last week. mulberry32 is four lines and good enough for choosing between plausible
 * strings; nothing here is security-sensitive.
 *
 * @param seed the starting state
 * @returns a function yielding the next value in `[0, 1)`
 */
function makeRandom(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * Picks an index weighted by `weights`, via inverse-CDF sampling against `rnd`.
 *
 * The same technique feeds two different distributions below: which hour of the day a job lands
 * in (fed `HOUR_WEIGHTS`), and which error code a failed job gets (fed `ERROR_CODE_WEIGHTS`).
 */
function pickWeightedIndex(weights: readonly number[], rnd: () => number): number {
	const total = weights.reduce((sum, weight) => sum + weight, 0);
	let target = rnd() * total;
	for (let i = 0; i < weights.length; i++) {
		target -= weights[i];
		if (target <= 0) {
			return i;
		}
	}
	return weights.length - 1;
}

/** Splits `items` into chunks of at most `size`, for batched `createMany` inserts. */
function chunk<T>(items: readonly T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		chunks.push(items.slice(i, i + size));
	}
	return chunks;
}

/** How many times busier a day is than the Monday–Thursday baseline. */
function weekdayFactor(dayOfWeek: number): number {
	if (dayOfWeek === 0) return 0.6; // Sunday
	if (dayOfWeek === 5 || dayOfWeek === 6) return 1.5; // Friday, Saturday
	return 1.0; // Monday–Thursday
}

/**
 * Relative job volume by hour of day, index 0 = midnight UTC. Lunch (11–13) and dinner (17–21)
 * each get a peak; overnight hours are quiet. Reused for the fleet queue-depth curve below, since
 * both are "how busy is the till right now".
 */
const HOUR_WEIGHTS: readonly number[] = [
	0.2, 0.1, 0.1, 0.1, 0.1, 0.2, 0.4, 0.6, 0.9, 1.1, 1.4, 2.2, 2.4, 1.6, 1.1, 0.9, 1.0, 1.8, 2.6, 2.8, 2.4, 1.8, 0.9,
	0.4,
];
const HOUR_WEIGHT_MAX = Math.max(...HOUR_WEIGHTS);

const ERROR_CODES = [
	"device_unreachable",
	"device_paused",
	"body_too_large",
	"unsupported_characters",
	"queue_full",
] as const;
/** Weighted toward the first entry. */
const ERROR_CODE_WEIGHTS: readonly number[] = [5, 3, 2, 1, 1];
const ERROR_MESSAGES: Record<(typeof ERROR_CODES)[number], string> = {
	device_unreachable: "The agent did not acknowledge the job within 10 seconds.",
	device_paused: "The printer is paused and is not accepting new jobs.",
	body_too_large: "The rendered payload exceeds the agent's maximum body size.",
	unsupported_characters: "The receipt contains a character the printer's codepage cannot represent.",
	queue_full: "The printer's queue is at its configured limit.",
};

/** One calendar day of the 90-day window, bounded so nothing is ever generated in the future. */
interface DaySpec {
	start: Date;
	/** 24 for every day except the last, which stops at the current UTC hour. */
	hoursAvailable: number;
	dayOfWeek: number;
}

interface JobRow {
	id: string;
	agentId: string;
	deviceId: string;
	apiKeyId: string | null;
	status: "COMPLETED" | "FAILED" | "CANCELLED" | "QUEUED" | "PRINTING";
	submittedAt: Date;
	queuedAt: Date | null;
	startedAt: Date | null;
	finishedAt: Date | null;
	lines: number | null;
	bytes: number | null;
	errorCode: string | null;
	errorMessage: string | null;
}

interface DeliveryRow {
	id: string;
	webhookId: string;
	jobId: string;
	payload: string;
	status: "DELIVERED" | "FAILED";
	attempts: number;
	nextAttemptAt: Date;
	lastError: string | null;
	deliveredAt: Date | null;
	createdAt: Date;
}

interface FleetRow {
	at: Date;
	agentsTotal: number;
	agentsOnline: number;
	devicesTotal: number;
	devicesConnected: number;
	queueDepth: number;
	pendingWebhooks: number;
	activeSessions: number;
	dbMainBytes: number;
	dbAuditBytes: number;
	dbLogsBytes: number;
}

interface ApiHourlyRow {
	bucket: Date;
	route: string;
	statusClass: string;
	apiKeyId: string;
	count: number;
	durationSumMs: number;
	durationHist: string;
}

interface AuthHourlyRow {
	bucket: Date;
	kind: string;
	count: number;
}

/**
 * Builds one hour's `MetricApiHourly` row, synthesising `count` request durations into a real
 * histogram rather than writing a bare number — the latency chart reads the histogram, not the
 * count alone.
 */
function buildApiHourlyRow(
	bucket: Date,
	route: string,
	statusClass: string,
	apiKeyId: string,
	count: number,
	minMs: number,
	maxMs: number,
	rnd: () => number,
): ApiHourlyRow {
	const histogram = emptyHistogram();
	let sum = 0;
	for (let i = 0; i < count; i++) {
		const ms = minMs + rnd() * (maxMs - minMs);
		addSample(histogram, ms);
		sum += ms;
	}
	return {
		bucket,
		route,
		statusClass,
		apiKeyId,
		count,
		durationSumMs: Math.round(sum),
		durationHist: serializeHistogram(histogram),
	};
}

/**
 * Better Auth's own identifier for an email-and-password credential — computed the same way
 * lib/auth/credential-account.ts does, by asking the library the same question rather than
 * transcribing its literal value. That module cannot be imported here: it opens with `import
 * "server-only"`, which throws outside Next's bundler. lib/auth/recover.ts recomputes the same
 * value for the identical reason, and this does what it does.
 */
const CREDENTIAL_ISSUER = createLocalAccountIssuer("credential");

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const cleanOnly = argv.includes("--clean");
	const force = argv.includes("--force");

	if (process.env.NODE_ENV === "production" && !force) {
		throw new Error("Refusing to seed demo data with NODE_ENV=production. Pass --force if you are certain.");
	}

	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl) {
		throw new Error("DATABASE_URL is not set. Copy .env.example to .env first.");
	}

	const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: databaseUrl }) });
	// Three sibling databases, addressed the way lib/env.ts and lib/db.ts derive them, so this
	// script writes to the files the running server reads.
	const logsDb = new LogsPrismaClient({
		adapter: new PrismaBetterSqlite3({
			url: process.env.LOGS_DATABASE_URL ?? siblingDatabaseUrl(databaseUrl, "logs.db"),
		}),
	});
	const metricsDb = new MetricsPrismaClient({
		adapter: new PrismaBetterSqlite3({
			url: process.env.METRICS_DATABASE_URL ?? siblingDatabaseUrl(databaseUrl, "metrics.db"),
		}),
	});
	const out = (line: string) => process.stdout.write(`${line}\n`);

	try {
		// Log lines and metrics rows are removed explicitly rather than by cascade: they live in
		// their own databases, which have no foreign key to the agents/devices/webhooks tables to
		// cascade through. Their ids have to be read before the rows they name go, because
		// afterwards there is nothing left to match them by.
		const demoAgents = await prisma.agent.findMany({
			where: { name: { startsWith: PREFIX } },
			select: { id: true },
		});
		const demoAgentIds = demoAgents.map((agent) => agent.id);

		const demoDevices = await prisma.device.findMany({
			where: { agentId: { in: demoAgentIds } },
			select: { id: true },
		});
		const demoDeviceIds = demoDevices.map((device) => device.id);

		const demoWebhooks = await prisma.webhook.findMany({
			where: { apiKey: { name: { startsWith: PREFIX } } },
			select: { id: true },
		});
		const demoWebhookIds = demoWebhooks.map((webhook) => webhook.id);

		const { count: removedLines } = await logsDb.logEntry.deleteMany({
			where: { agentId: { in: demoAgentIds } },
		});

		const { count: removedJobHourly } = await metricsDb.metricJobHourly.deleteMany({
			where: { deviceId: { in: demoDeviceIds } },
		});
		const { count: removedErrorHourly } = await metricsDb.metricErrorHourly.deleteMany({
			where: { deviceId: { in: demoDeviceIds } },
		});
		const { count: removedWebhookHourly } = await metricsDb.metricWebhookHourly.deleteMany({
			where: { webhookId: { in: demoWebhookIds } },
		});
		// fleet_samples, metric_api_hourly, metric_auth_hourly and metric_watermarks carry no
		// per-agent or per-device column to scope a demo match against — they are fleet-wide
		// observability data, not per-entity records (see the header comment on
		// prisma/metrics.prisma). This script only ever runs against a development database, so
		// clearing them wholesale on every run is correct: the alternative is a second run's fleet
		// history silently stacking on top of the first's.
		const { count: removedFleetSamples } = await metricsDb.fleetSample.deleteMany({});
		const { count: removedApiHourly } = await metricsDb.metricApiHourly.deleteMany({});
		const { count: removedAuthHourly } = await metricsDb.metricAuthHourly.deleteMany({});
		const { count: removedWatermarks } = await metricsDb.metricWatermark.deleteMany({});

		// Agents cascade to their devices, jobs and pairing codes, so removing them takes almost
		// everything else with it. Keys are the exception: they belong to no agent. Deleting a key
		// cascades its webhook (Webhook.apiKeyId → ApiKey, onDelete: Cascade), which cascades its
		// deliveries in turn.
		const { count: removedAgents } = await prisma.agent.deleteMany({ where: { name: { startsWith: PREFIX } } });
		const { count: removedKeys } = await prisma.apiKey.deleteMany({ where: { name: { startsWith: PREFIX } } });

		// Users cascade to their sessions, accounts, two-factor enrolments and role memberships —
		// every one of those relations is `onDelete: Cascade` in schema.prisma — so one deleteMany
		// clears every credential this script wrote. The demo-viewer role is not owned by any user,
		// so it is removed on its own.
		const { count: removedUsers } = await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });
		const { count: removedRoles } = await prisma.role.deleteMany({ where: { name: { startsWith: PREFIX } } });

		out(
			`Removed ${removedAgents} demo agents, ${removedKeys} demo keys, ${removedUsers} demo users, ` +
				`${removedRoles} demo roles and ${removedLines} demo log lines.`,
		);
		out(
			`Removed ${removedJobHourly} job-hourly, ${removedErrorHourly} error-hourly, ` +
				`${removedWebhookHourly} webhook-hourly, ${removedFleetSamples} fleet-sample, ` +
				`${removedApiHourly} api-hourly and ${removedAuthHourly} auth-hourly metrics rows ` +
				`(plus ${removedWatermarks} watermarks).`,
		);

		if (cleanOnly) {
			out("Nothing seeded (--clean).");
			return;
		}

		const random = makeRandom(RANDOM_SEED);
		const now = Date.now();
		const nowDate = new Date(now);
		const at = (msAgo: number) => new Date(now - msAgo);
		const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)];

		// --- Agents -------------------------------------------------------------------------

		// Paired agents carry a token hash, which is what the panel reads to decide whether an
		// agent has completed pairing. The value is nonsense; nothing will ever authenticate with
		// it, and a real token is 256 bits of CSPRNG output that this script has no business
		// minting.
		const kitchen = await prisma.agent.create({
			data: {
				name: `${PREFIX}kitchen-pi`,
				status: "OFFLINE",
				tokenHash: `${PREFIX}token-kitchen`,
				lastSeenAt: at(4 * 60 * 1000),
				agentVersion: "1.0.0",
				platform: "Linux 6.6 aarch64",
				hostname: "kitchen-pi",
				lastAddress: "192.168.1.24",
				createdAt: at(30 * DAY),
			},
		});

		const bar = await prisma.agent.create({
			data: {
				name: `${PREFIX}bar-pi`,
				status: "OFFLINE",
				tokenHash: `${PREFIX}token-bar`,
				lastSeenAt: at(3 * DAY),
				agentVersion: "0.9.4",
				platform: "Linux 6.1 armv7l",
				hostname: "bar-pi",
				lastAddress: "192.168.1.31",
				createdAt: at(21 * DAY),
			},
		});

		// Never paired: no token, and an unconsumed code waiting to be typed in. This is what the
		// Agents tab shows before an agent has ever connected.
		const unpaired = await prisma.agent.create({
			data: { name: `${PREFIX}office-pi`, status: "PENDING", createdAt: at(2 * HOUR) },
		});

		await prisma.pairingCode.create({
			data: {
				agentId: unpaired.id,
				code: "DEMO-4821-QK",
				createdAt: at(2 * HOUR),
				expiresAt: at(-30 * 60 * 1000),
			},
		});

		out(`Created 3 agents: ${kitchen.name}, ${bar.name}, ${unpaired.name}`);

		// --- Devices ------------------------------------------------------------------------

		// Deliberately varied, because most layout problems only appear when two rows disagree:
		// 80mm beside 58mm, wrapping on beside off, one paused.
		const kitchenMain = await prisma.device.create({
			data: {
				agentId: kitchen.id,
				name: "kitchen",
				port: "/dev/ttyUSB0",
				baudRate: 19200,
				columns: 42,
				codepage: "CP858",
				defaultWrap: true,
				defaultLinefeed: "LF",
				createdAt: at(30 * DAY),
			},
		});

		const kitchenLabels = await prisma.device.create({
			data: {
				agentId: kitchen.id,
				name: "labels",
				port: "/dev/ttyUSB1",
				columns: 32,
				codepage: "CP437",
				defaultWrap: false,
				defaultLinefeed: "NONE",
				paused: true,
				maxQueueDepth: 20,
				createdAt: at(12 * DAY),
			},
		});

		const barMain = await prisma.device.create({
			data: {
				agentId: bar.id,
				name: "bar",
				port: "COM3",
				baudRate: 38400,
				columns: 42,
				codepage: "CP858",
				onUnsupported: "REPLACE",
				autoReconnect: false,
				createdAt: at(21 * DAY),
			},
		});

		const barCustomer = await prisma.device.create({
			data: {
				agentId: bar.id,
				name: "customer-copy",
				port: "COM4",
				columns: 32,
				codepage: "CP852",
				onUnsupported: "STRIP",
				createdAt: at(9 * DAY),
			},
		});

		const devices = [kitchenMain, kitchenLabels, barMain, barCustomer];
		out(`Created ${devices.length} printers.`);

		// --- API keys -----------------------------------------------------------------------

		// Minted with the same primitives the panel uses — the prefix and hint length from
		// key-format, the token and hash from secrets — so a demo key authenticates exactly like a
		// real one. `key-service` itself is server-only and cannot be reached from here, which is
		// precisely why those two values live in a module of their own rather than inside it.
		const mint = async (
			name: string,
			permissions: readonly string[],
			deviceIds: readonly string[],
			extra: { revokedAt?: Date; lastUsedAt?: Date; createdAt?: Date } = {},
		) => {
			const secret = KEY_PREFIX + generateToken();
			const key = await prisma.apiKey.create({
				data: {
					name,
					keyHash: hashSecret(secret),
					maskedHint: secret.slice(-HINT_LENGTH),
					permissions: { create: permissions.map((permission) => ({ permission })) },
					devices: { create: deviceIds.map((deviceId) => ({ deviceId })) },
					...extra,
				},
				select: { id: true },
			});
			return { id: key.id, name, secret };
		};

		const till = await mint(
			`${PREFIX}front-till`,
			["jobs:submit", "jobs:read", "status:read"],
			[kitchenMain.id, barMain.id],
			{ createdAt: at(28 * DAY), lastUsedAt: at(11 * 60 * 1000) },
		);
		// No lastUsedAt: "never used" is a state the panel renders differently, so one key has it.
		const display = await mint(`${PREFIX}kitchen-display`, ["jobs:read", "devices:read"], [kitchenMain.id], {
			createdAt: at(6 * DAY),
		});
		await mint(`${PREFIX}old-terminal`, ["jobs:submit"], [barCustomer.id], {
			createdAt: at(60 * DAY),
			revokedAt: at(5 * DAY),
		});

		out("Created 3 API keys (one revoked, one never used).");

		// --- Jobs ---------------------------------------------------------------------------

		// 90 days of history, so every chart on the Statistics page has enough data for its trend
		// to mean something — a week of jobs makes a day-of-week comparison meaningless, and a
		// p95/p99 split needs enough samples per bucket to actually diverge.
		const NUM_DAYS = 90;
		const JOB_BASE_PER_DAY = 170;

		const todayUtcStartMs = Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), nowDate.getUTCDate());
		const currentHourStartMs = Math.floor(now / HOUR) * HOUR;
		// How many full UTC hours of "today" have happened so far. Bounds the last day's
		// generation so nothing is ever submitted in the future — and since it depends only on the
		// calendar date, not the exact millisecond, two runs made minutes apart on the same day
		// produce the identical count.
		const hoursElapsedToday = Math.floor((currentHourStartMs - todayUtcStartMs) / HOUR);

		const days: DaySpec[] = [];
		for (let i = 0; i < NUM_DAYS; i++) {
			const startMs = todayUtcStartMs - (NUM_DAYS - 1 - i) * DAY;
			const isToday = i === NUM_DAYS - 1;
			days.push({
				start: new Date(startMs),
				hoursAvailable: isToday ? hoursElapsedToday : 24,
				dayOfWeek: new Date(startMs).getUTCDay(),
			});
		}

		const jobRows: JobRow[] = [];
		// Job counts per UTC hour bucket (epoch ms), reused below by metric_api_hourly's "job
		// curve × 1.3" so the two don't have to agree by coincidence.
		const jobsPerHourBucket = new Map<number, number>();

		for (const day of days) {
			if (day.hoursAvailable === 0) continue;

			const factor = weekdayFactor(day.dayOfWeek);
			const dayTotal = Math.round(JOB_BASE_PER_DAY * factor * (0.9 + random() * 0.2));
			const hourWeights = HOUR_WEIGHTS.slice(0, day.hoursAvailable);

			for (let j = 0; j < dayTotal; j++) {
				const hour = pickWeightedIndex(hourWeights, random);
				const bucketMs = day.start.getTime() + hour * HOUR;
				const submittedAt = new Date(bucketMs + Math.floor(random() * HOUR));
				jobsPerHourBucket.set(bucketMs, (jobsPerHourBucket.get(bucketMs) ?? 0) + 1);

				const device = pick(devices);
				const isLabels = device.id === kitchenLabels.id;

				const outcomeRoll = random();
				const status: JobRow["status"] = outcomeRoll < 0.93 ? "COMPLETED" : outcomeRoll < 0.97 ? "FAILED" : "CANCELLED";

				const queueMs = 50 + random() * 450;
				// 2% of jobs are latency outliers — stuck behind a paper change, a slow USB bus,
				// whatever — which is what makes p95/p99 visibly diverge from the median.
				const isOutlier = random() < 0.02;
				let printMs = isOutlier ? 10_000 + random() * 110_000 : 300 + random() * 2700;
				// "labels" is systematically slower, so "slowest printers" has a real answer.
				if (isLabels) printMs *= 3;

				const queuedAt = new Date(submittedAt.getTime() + 5 + Math.floor(random() * 40));
				const startedAt = new Date(queuedAt.getTime() + Math.round(queueMs));
				const finishedAt = new Date(startedAt.getTime() + Math.round(printMs));

				const lines = 5 + Math.floor(random() * 76);
				const bytesRaw = 200 + ((lines - 5) / 75) * 3800 + (random() - 0.5) * 400;
				const bytes = Math.min(4000, Math.max(200, Math.round(bytesRaw)));

				// ~40% of jobs arrive through the API; the rest are panel-submitted and carry no key.
				const apiKeyId = random() < 0.4 ? (random() < 0.7 ? till.id : display.id) : null;

				let errorCode: string | null = null;
				let errorMessage: string | null = null;
				if (status === "FAILED") {
					const code = ERROR_CODES[pickWeightedIndex(ERROR_CODE_WEIGHTS, random)];
					errorCode = code;
					errorMessage = ERROR_MESSAGES[code];
				}

				jobRows.push({
					id: crypto.randomUUID(),
					agentId: device.agentId,
					deviceId: device.id,
					apiKeyId,
					status,
					submittedAt,
					queuedAt,
					startedAt,
					finishedAt,
					lines,
					bytes,
					errorCode,
					errorMessage,
				});
			}
		}

		// A handful of jobs still in flight, so the Jobs tab has something in every status rather
		// than only ever showing history.
		const inFlight: Array<{ status: "QUEUED" | "PRINTING"; ago: number }> = [
			{ status: "QUEUED", ago: 90 * 1000 },
			{ status: "QUEUED", ago: 6 * 60 * 1000 },
			{ status: "PRINTING", ago: 15 * 1000 },
			{ status: "PRINTING", ago: 45 * 1000 },
		];
		for (const spec of inFlight) {
			const device = pick(devices);
			const submittedAt = at(spec.ago);
			const queuedAt = new Date(submittedAt.getTime() + 20 + Math.floor(random() * 80));
			jobRows.push({
				id: crypto.randomUUID(),
				agentId: device.agentId,
				deviceId: device.id,
				apiKeyId: random() < 0.4 ? till.id : null,
				status: spec.status,
				submittedAt,
				queuedAt,
				startedAt: spec.status === "PRINTING" ? new Date(queuedAt.getTime() + 200) : null,
				finishedAt: null,
				lines: null,
				bytes: null,
				errorCode: null,
				errorMessage: null,
			});
		}

		for (const batch of chunk(jobRows, 500)) {
			await prisma.job.createMany({ data: batch });
		}
		out(`Created ${jobRows.length} jobs across 90 days of history (${inFlight.length} still in flight).`);

		// --- Webhook + deliveries ------------------------------------------------------------

		const webhook = await prisma.webhook.create({
			data: {
				apiKeyId: till.id,
				url: "https://example.com/hooks/fenpos-demo",
				secret: `${PREFIX}webhook-${generateToken()}`,
				enabled: true,
			},
			select: { id: true },
		});

		const deliveryRows: DeliveryRow[] = [];
		// Roughly one delivery per 8 jobs, striding rather than sampling so the count stays exactly
		// deterministic across runs.
		for (let i = 0; i < jobRows.length; i += 8) {
			const job = jobRows[i];
			if (!job.finishedAt) continue; // still in flight — nothing has settled to notify about

			const settleAt = job.finishedAt;
			const roll = random();
			let attempts: number;
			let status: "DELIVERED" | "FAILED";
			let deliveredAt: Date | null;
			let lastError: string | null;

			if (roll < 0.9) {
				attempts = 1;
				status = "DELIVERED";
				deliveredAt = new Date(settleAt.getTime() + 200 + Math.floor(random() * 1800));
				lastError = null;
			} else if (roll < 0.97) {
				attempts = 2 + Math.floor(random() * 3);
				status = "DELIVERED";
				deliveredAt = new Date(settleAt.getTime() + attempts * 5000 + Math.floor(random() * 3000));
				lastError = "The receiving endpoint timed out on an earlier attempt.";
			} else {
				attempts = 5;
				status = "FAILED";
				deliveredAt = null;
				lastError = "The receiving endpoint returned a non-2xx status after 5 attempts.";
			}

			deliveryRows.push({
				id: crypto.randomUUID(),
				webhookId: webhook.id,
				jobId: job.id,
				payload: JSON.stringify({ jobId: job.id, status: job.status }),
				status,
				attempts,
				nextAttemptAt: deliveredAt ?? new Date(settleAt.getTime() + attempts * 5000),
				lastError,
				deliveredAt,
				createdAt: settleAt,
			});
		}

		for (const batch of chunk(deliveryRows, 500)) {
			await prisma.webhookDelivery.createMany({ data: batch });
		}
		out(`Created 1 demo webhook and ${deliveryRows.length} deliveries.`);

		// --- Fleet samples ---------------------------------------------------------------------

		const FLEET_INTERVAL_MS = 30 * 60 * 1000;
		const fleetStartMs = days[0].start.getTime();
		const totalFleetTicks = Math.max(0, Math.floor((currentHourStartMs - fleetStartMs) / FLEET_INTERVAL_MS));

		// Five random day-long windows where only one agent is online, so the fleet chart has real
		// dips rather than a flat line at "2".
		const incidentDays = new Set<number>();
		while (incidentDays.size < Math.min(5, NUM_DAYS)) {
			incidentDays.add(Math.floor(random() * NUM_DAYS));
		}

		const MB = 1024 * 1024;
		const fleetRows: FleetRow[] = [];
		for (let t = 0; t < totalFleetTicks; t++) {
			const atMs = fleetStartMs + t * FLEET_INTERVAL_MS;
			const dayIndex = Math.floor((atMs - fleetStartMs) / DAY);
			const hour = new Date(atMs).getUTCHours();
			const weight = HOUR_WEIGHTS[hour];

			// kitchen-pi and bar-pi each host two devices; a dip drops one of them offline along
			// with its pair of printers.
			const agentsOnline = incidentDays.has(dayIndex) ? 1 : 2;
			const devicesConnected = agentsOnline * 2;

			const queueDepth = Math.min(8, Math.max(0, Math.round((weight / HOUR_WEIGHT_MAX) * 6 + random() * 2)));
			const pendingWebhooks = Math.floor(random() * 4);
			const activeSessions = 1 + Math.floor(random() * 4);

			const progress = totalFleetTicks <= 1 ? 1 : t / (totalFleetTicks - 1);
			const jitter = 0.95 + random() * 0.1;
			const dbMainBytes = Math.round((5 + progress * (80 - 5)) * jitter * MB);
			const dbAuditBytes = Math.round((1 + progress * (10 - 1)) * jitter * MB);
			const dbLogsBytes = Math.round((2 + progress * (40 - 2)) * jitter * MB);

			fleetRows.push({
				at: new Date(atMs),
				agentsTotal: 3,
				agentsOnline,
				devicesTotal: 4,
				devicesConnected,
				queueDepth,
				pendingWebhooks,
				activeSessions,
				dbMainBytes,
				dbAuditBytes,
				dbLogsBytes,
			});
		}

		for (const batch of chunk(fleetRows, 500)) {
			await metricsDb.fleetSample.createMany({ data: batch });
		}
		out(`Created ${fleetRows.length} fleet samples (${incidentDays.size} incident days).`);

		// --- API traffic -------------------------------------------------------------------------

		const apiRows: ApiHourlyRow[] = [];
		for (const day of days) {
			for (let hour = 0; hour < day.hoursAvailable; hour++) {
				const bucket = new Date(day.start.getTime() + hour * HOUR);
				const jobsInHour = jobsPerHourBucket.get(bucket.getTime()) ?? 0;

				if (jobsInHour > 0) {
					apiRows.push(
						buildApiHourlyRow(
							bucket,
							"api:POST /v1/print",
							"2xx",
							till.id,
							Math.max(1, Math.round(jobsInHour * 1.3)),
							5,
							80,
							random,
						),
					);
					apiRows.push(
						buildApiHourlyRow(
							bucket,
							"api:GET /v1/jobs",
							"2xx",
							display.id,
							Math.max(1, Math.round(jobsInHour * 0.6)),
							5,
							80,
							random,
						),
					);
					apiRows.push(
						buildApiHourlyRow(
							bucket,
							"api:GET /v1/devices",
							"2xx",
							display.id,
							Math.max(1, Math.round(jobsInHour * 0.15)),
							5,
							80,
							random,
						),
					);
				}

				if (random() < 0.05) {
					apiRows.push(
						buildApiHourlyRow(
							bucket,
							"api:POST /v1/print",
							"4xx",
							till.id,
							1 + Math.floor(random() * 4),
							5,
							80,
							random,
						),
					);
				}
				if (random() < 0.03) {
					apiRows.push(
						buildApiHourlyRow(bucket, "reject:auth", "4xx", "", 1 + Math.floor(random() * 3), 5, 80, random),
					);
				}
				if (random() < 0.02) {
					apiRows.push(
						buildApiHourlyRow(bucket, "reject:rate-limit", "4xx", "", 1 + Math.floor(random() * 3), 5, 80, random),
					);
				}
				if (random() < 0.02) {
					apiRows.push(
						buildApiHourlyRow(bucket, "reject:validation", "4xx", "", 1 + Math.floor(random() * 3), 5, 80, random),
					);
				}
			}
		}

		for (const batch of chunk(apiRows, 500)) {
			await metricsDb.metricApiHourly.createMany({ data: batch });
		}
		out(`Created ${apiRows.length} api-hourly rows.`);

		// --- Auth activity -----------------------------------------------------------------------

		const authRowsByKey = new Map<string, AuthHourlyRow>();
		function addAuthCount(bucket: Date, kind: string, count: number): void {
			const key = `${bucket.getTime()}|${kind}`;
			const existing = authRowsByKey.get(key);
			if (existing) existing.count += count;
			else authRowsByKey.set(key, { bucket, kind, count });
		}

		for (const day of days) {
			if (day.hoursAvailable === 0) continue;
			const randomBucket = () => new Date(day.start.getTime() + Math.floor(random() * day.hoursAvailable) * HOUR);

			addAuthCount(randomBucket(), "signin_success", 2 + Math.floor(random() * 7));
			if (random() < 0.3) addAuthCount(randomBucket(), "signin_failed", 1 + Math.floor(random() * 3));
			if (random() < 0.15) addAuthCount(randomBucket(), "denied_action", 1 + Math.floor(random() * 3));
			if (random() < 0.03) addAuthCount(randomBucket(), "twofactor_failed", 1);
		}

		// Three brute-force incidents: a burst of failed sign-ins concentrated in one hour each, on
		// top of the ordinary trickle above.
		const availableDays = days.filter((day) => day.hoursAvailable > 0);
		for (let i = 0; i < 3; i++) {
			const day = pick(availableDays);
			const hour = Math.floor(random() * day.hoursAvailable);
			addAuthCount(new Date(day.start.getTime() + hour * HOUR), "signin_failed", 20 + Math.floor(random() * 41));
		}

		const authRows = [...authRowsByKey.values()];
		for (const batch of chunk(authRows, 500)) {
			await metricsDb.metricAuthHourly.createMany({ data: batch });
		}
		out(`Created ${authRows.length} auth-hourly rows (3 brute-force incidents included).`);

		// --- Demo accounts -----------------------------------------------------------------------

		const admin = await prisma.user.create({
			data: {
				id: crypto.randomUUID(),
				email: `${PREFIX}admin@fenpos.local`,
				name: "Demo Admin",
				emailVerified: true,
				isSuperuser: true,
				createdAt: nowDate,
				updatedAt: nowDate,
			},
		});
		await prisma.account.create({
			data: {
				id: crypto.randomUUID(),
				userId: admin.id,
				issuer: CREDENTIAL_ISSUER,
				providerId: "credential",
				accountId: admin.id,
				password: await hashPassword("DemoAdmin!23456"),
				createdAt: nowDate,
				updatedAt: nowDate,
			},
		});

		// Deliberately no stats:read: this is what "a colleague who should not see the numbers"
		// looks like on the Statistics page's own permission gate.
		const viewerRole = await prisma.role.create({
			data: { name: `${PREFIX}viewer`, description: "Demo role: sees the Dashboard, not Statistics." },
			select: { id: true },
		});
		await prisma.rolePermission.create({ data: { roleId: viewerRole.id, permission: "dashboard:read" } });

		const viewer = await prisma.user.create({
			data: {
				id: crypto.randomUUID(),
				email: `${PREFIX}viewer@fenpos.local`,
				name: "Demo Viewer",
				emailVerified: true,
				isSuperuser: false,
				createdAt: nowDate,
				updatedAt: nowDate,
			},
		});
		await prisma.userRole.create({ data: { userId: viewer.id, roleId: viewerRole.id } });
		await prisma.account.create({
			data: {
				id: crypto.randomUUID(),
				userId: viewer.id,
				issuer: CREDENTIAL_ISSUER,
				providerId: "credential",
				accountId: viewer.id,
				password: await hashPassword("DemoViewer!23456"),
				createdAt: nowDate,
				updatedAt: nowDate,
			},
		});

		out(`Created 2 demo accounts: ${admin.email} (superuser), ${viewer.email} (dashboard:read only).`);

		// --- Roll up and report --------------------------------------------------------------

		// `nowDate` rather than a fresh `new Date()`: reusing the same instant the rest of this run
		// generated data against keeps the rollup's "current hour" boundary in step with
		// `hoursElapsedToday` above, so two runs a few seconds apart on the same day roll exactly
		// the same hours.
		const { rolledHours } = await runMetricsRollup({ db: prisma, metricsDb, auditDb: null }, nowDate);
		out(`Rolled ${rolledHours} stream-hours into metric_job_hourly / metric_error_hourly / metric_webhook_hourly.`);

		const [jobHourlyCount, errorHourlyCount, webhookHourlyCount, apiHourlyCount, authHourlyCount, fleetSampleCount] =
			await Promise.all([
				metricsDb.metricJobHourly.count(),
				metricsDb.metricErrorHourly.count(),
				metricsDb.metricWebhookHourly.count(),
				metricsDb.metricApiHourly.count(),
				metricsDb.metricAuthHourly.count(),
				metricsDb.fleetSample.count(),
			]);

		out("");
		out("Metrics table row counts:");
		out(`  metric_job_hourly     ${jobHourlyCount}`);
		out(`  metric_error_hourly   ${errorHourlyCount}`);
		out(`  metric_webhook_hourly ${webhookHourlyCount}`);
		out(`  metric_api_hourly     ${apiHourlyCount}`);
		out(`  metric_auth_hourly    ${authHourlyCount}`);
		out(`  fleet_samples         ${fleetSampleCount}`);

		// --- Log lines ----------------------------------------------------------------------

		// Attached to a seeded agent so that the cleanup above can find them again. A demo log line
		// with no agent id would survive every cleanup this script can perform, since its database
		// holds no name to match on.
		const LINES = [
			["INFO", "Agent connected"],
			["INFO", "Port opened"],
			["INFO", "Job printed"],
			["INFO", "Configuration pushed"],
			["DEBUG", "Heartbeat acknowledged"],
			["DEBUG", "Queue drained"],
			["WARN", "Reconnecting after a dropped link"],
			["WARN", "Printer reported the paper is low"],
			["ERROR", "Write timed out after 5000ms"],
			["ERROR", "Port /dev/ttyUSB1 disappeared"],
		] as const;

		const agentIds = [kitchen.id, bar.id] as const;
		const logs = Array.from({ length: 60 }, (_, index) => {
			const [level, message] = pick(LINES);
			return {
				level,
				severity: LOG_SEVERITY[level],
				message,
				agentId: pick(agentIds),
				ts: at(Math.floor(random() * 2 * DAY) + index * 60 * 1000),
			};
		});

		await logsDb.logEntry.createMany({ data: logs });
		out(`Created ${logs.length} log lines.`);

		// --- The secrets ---------------------------------------------------------------------

		// Printed because they are otherwise unrecoverable — a key is shown once and stored as a
		// hash — and a demo key nobody can use is a demo key that cannot exercise the API.
		out("");
		out("Demo API keys, shown once:");
		out(`  ${till.name.padEnd(24)} ${till.secret}`);
		out(`  ${display.name.padEnd(24)} ${display.secret}`);
		out("");
		out("Demo accounts:");
		out(`  ${admin.email.padEnd(24)} DemoAdmin!23456   (superuser)`);
		out(`  ${viewer.email.padEnd(24)} DemoViewer!23456  (dashboard:read only, no stats:read)`);
		out("");
		out("Pairing code waiting on demo-office-pi: DEMO-4821-QK");
		out("Run `pnpm db:seed --clean` to remove all of it.");
	} finally {
		await prisma.$disconnect();
		await logsDb.$disconnect();
		await metricsDb.$disconnect();
	}
}

main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
});
