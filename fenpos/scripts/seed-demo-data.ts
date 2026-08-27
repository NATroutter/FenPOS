import "dotenv/config";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../generated/prisma/client";
import { PrismaClient as LogsPrismaClient } from "../generated/prisma-logs/client";
import { generateToken, hashSecret } from "../lib/auth/secrets";
import { siblingDatabaseUrl } from "../lib/database-url";
import { HINT_LENGTH, KEY_PREFIX } from "../lib/keys/key-format";
import { LOG_SEVERITY } from "../lib/logs/log-sort";

/**
 * Fills a development database with enough plausible data to see every screen populated.
 *
 * Building a panel against an empty database means every list is an empty state, every filter has
 * nothing to filter, and layout problems only appear on the day real data arrives. This produces
 * agents in different conditions, printers with different paper widths, keys with different
 * grants, and a few days of jobs and logs across every status and level.
 *
 * Usage:
 *   pnpm db:seed            # replace the demo data with a fresh set
 *   pnpm db:seed --clean    # remove it and stop
 *
 * **Everything it creates is named `demo-…`, and it only ever deletes rows with those names.**
 * That is what makes it safe to run against a database you have been working in: your own agents,
 * printers and keys are untouched, and re-running replaces the demo set rather than piling a
 * second copy on top of the first.
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
	// Two clients because there are two databases. The logs URL is derived from DATABASE_URL the
	// same way lib/env.ts derives it, so this script addresses the file the running server does.
	const logsDb = new LogsPrismaClient({
		adapter: new PrismaBetterSqlite3({
			url: process.env.LOGS_DATABASE_URL ?? siblingDatabaseUrl(databaseUrl, "logs.db"),
		}),
	});
	const out = (line: string) => process.stdout.write(`${line}\n`);

	try {
		// Log lines are removed explicitly rather than by cascade: they live in their own database,
		// which has no foreign key to the agents table to cascade through. Their agent ids have to be
		// read before the agents go, because afterwards there is nothing left to match them by.
		const demoAgents = await prisma.agent.findMany({
			where: { name: { startsWith: PREFIX } },
			select: { id: true },
		});
		const { count: removedLines } = await logsDb.logEntry.deleteMany({
			where: { agentId: { in: demoAgents.map((agent) => agent.id) } },
		});

		// Agents cascade to their devices, jobs and pairing codes, so removing them takes almost
		// everything else with it. Keys are the exception: they belong to no agent.
		const { count: removedAgents } = await prisma.agent.deleteMany({ where: { name: { startsWith: PREFIX } } });
		const { count: removedKeys } = await prisma.apiKey.deleteMany({ where: { name: { startsWith: PREFIX } } });
		out(`Removed ${removedAgents} demo agents, ${removedKeys} demo keys and ${removedLines} demo log lines.`);

		if (cleanOnly) {
			out("Nothing seeded (--clean).");
			return;
		}

		const random = makeRandom(RANDOM_SEED);
		const now = Date.now();
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
			["print", "jobs:read", "status:read"],
			[kitchenMain.id, barMain.id],
			{ createdAt: at(28 * DAY), lastUsedAt: at(11 * 60 * 1000) },
		);
		// No lastUsedAt: "never used" is a state the panel renders differently, so one key has it.
		const display = await mint(`${PREFIX}kitchen-display`, ["jobs:read", "devices:read"], [kitchenMain.id], {
			createdAt: at(6 * DAY),
		});
		await mint(`${PREFIX}old-terminal`, ["print"], [barCustomer.id], {
			createdAt: at(60 * DAY),
			revokedAt: at(5 * DAY),
		});

		out("Created 3 API keys (one revoked, one never used).");

		// --- Jobs ---------------------------------------------------------------------------

		// Weighted so the list looks like a working install rather than a test matrix: mostly
		// completed, a handful of failures, a couple still in flight. The dashboard's 24-hour
		// counters and the Jobs filters both need enough spread to be worth looking at.
		const OUTCOMES = [
			...Array<"COMPLETED">(22).fill("COMPLETED"),
			"FAILED",
			"FAILED",
			"FAILED",
			"CANCELLED",
			"CANCELLED",
			"QUEUED",
			"QUEUED",
			"PRINTING",
		] as const;

		const FAILURES = [
			["device_offline", "The agent is not connected."],
			["line_too_long", "Line 4 is 61 characters; the printer is 42 columns wide."],
			["unsupported_character", "Character 'ł' (U+0142) cannot be printed in codepage CP858."],
			["agent_timeout", "The agent did not acknowledge the job within 10 seconds."],
			["queue_full", "The printer's queue is at its limit of 20 jobs."],
		] as const;

		const apiKeyIds = [till.id, display.id, null, null] as const;
		let jobCount = 0;

		for (const [index, status] of OUTCOMES.entries()) {
			const device = pick(devices);
			// Spread back over three days, newest first, so the 24-hour window holds a useful
			// share of them rather than all or none.
			const submittedAgo = Math.floor(index * (3 * DAY) * (0.25 + random() * 0.75)) / OUTCOMES.length + random() * HOUR;
			const submittedAt = at(submittedAgo);
			const queuedAt = new Date(submittedAt.getTime() + 40 + random() * 200);
			const startedAt = new Date(queuedAt.getTime() + 200 + random() * 2000);
			const finishedAt = new Date(startedAt.getTime() + 300 + random() * 4000);
			const lines = 6 + Math.floor(random() * 40);
			const failure = pick(FAILURES);

			await prisma.job.create({
				data: {
					agentId: device.agentId,
					deviceId: device.id,
					apiKeyId: pick(apiKeyIds),
					status,
					submittedAt,
					queuedAt: status === "QUEUED" ? queuedAt : queuedAt,
					startedAt: status === "QUEUED" ? null : startedAt,
					finishedAt: status === "QUEUED" || status === "PRINTING" ? null : finishedAt,
					lines: status === "QUEUED" ? null : lines,
					bytes: status === "QUEUED" ? null : lines * (device.columns + 2) + 24,
					errorCode: status === "FAILED" ? failure[0] : null,
					errorMessage: status === "FAILED" ? failure[1] : null,
				},
			});
			jobCount += 1;
		}

		out(`Created ${jobCount} jobs across every status.`);

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
		out("Pairing code waiting on demo-office-pi: DEMO-4821-QK");
		out("Run `pnpm db:seed --clean` to remove all of it.");
	} finally {
		await prisma.$disconnect();
		await logsDb.$disconnect();
	}
}

main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
});
