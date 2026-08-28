import { purgeExpiredPairingCodes } from "@/lib/agents/pairing";
import { rotateSetupKey } from "@/lib/auth/setup-key";
import { prisma } from "@/lib/db";
import { attachAgentLink, shutdownAgentLinks } from "@/lib/link/link-server";
import { getHttpServer } from "@/lib/link/server-handle";
import { logger } from "@/lib/logger";
import { runMaintenancePass } from "@/lib/maintenance/pass";
import { applyPushedSettings } from "@/lib/settings/settings-service";
import { deliverDue } from "@/lib/webhooks/deliver";

/**
 * How often a pass drains due webhook deliveries.
 *
 * `webhooks.retryBackoffSeconds` schedules retries minutes apart, so a shorter tick would only
 * poll a table that has not changed; a longer one would add that much latency to the common case
 * where the first attempt succeeds and there was never anything to retry.
 */
const DELIVERY_DRAIN_INTERVAL_MS = 5_000;

/**
 * How often a maintenance pass runs.
 *
 * A period is a calendar month, so hourly is already about seven hundred times more often than a
 * pass can possibly do anything. The cadence is not about being timely — it is so the first pass
 * after a restart is prompt, and so an install that has stopped writing still sweeps.
 */
const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Startup work for the Node.js runtime.
 *
 * Reached only through the guard in instrumentation.ts, so imports here may freely use
 * Node.js built-ins and the database. Keeping them out of that module is what stops the edge
 * bundle pulling in Prisma and failing to compile.
 */
export async function registerRuntime(): Promise<void> {
	await announceSetupKey();
	await runMaintenance();
	// Seeds modules that hold a mutable value pushed from the store — the logger's minimum
	// level today — with whatever is saved. Placed after the maintenance queries above so it
	// runs once the database has already proven reachable, rather than being the first query
	// attempted at startup.
	await applyPushedSettings();
	attachLink();
	startDeliveryDrain();
	startMaintenance();
}

/**
 * Prints the setup key, minting a fresh one on every boot while the install is unclaimed.
 *
 * Rotating on each start is the deliberate difference from the administrator password this
 * replaces, which had to be stored in the clear so it could be reprinted. Nothing is bound to a
 * setup key, so replacing it costs nothing — and it means an operator who scrolled past the
 * message, restarted before claiming, or came to a container whose first logs have rotated away
 * simply restarts, while a key someone else glimpsed stops working at the same moment.
 *
 * Silent on a claimed install, so this can never become background noise nobody reads.
 *
 * Written straight to stdout rather than through the logger, and framed, because it is the one
 * thing in the output an operator must not miss.
 *
 * A failure here blocks claiming the install but not serving it, so it is reported rather than
 * thrown: the logs explaining what went wrong are easier to reach with the server up.
 */
async function announceSetupKey(): Promise<void> {
	try {
		const key = await rotateSetupKey();
		if (!key) {
			return;
		}

		const rule = "─".repeat(66);
		process.stdout.write(
			`\n${rule}\n` +
				`  This install has no accounts yet. Claim it with this setup key:\n\n` +
				`      ${key}\n\n` +
				`  Open the panel, enter the key, and create the first account. A new key\n` +
				`  is issued on every restart until you do, and this message then stops.\n` +
				`${rule}\n\n`,
		);
	} catch (error) {
		logger.error("Could not mint or print the setup key", error);
	}
}

/**
 * One-time housekeeping at boot.
 *
 * Every step is individually guarded and none is fatal. Neither task here is required for the
 * server to serve correctly: a stale agent status corrects itself as soon as that agent
 * reconnects, and an expired pairing code already fails its own expiry check on the read path
 * (see `redeemPairingCode` in `lib/agents/pairing.ts`), so leaving one unpurged is cosmetic
 * clutter, not a live credential. Refusing to start over a housekeeping error would therefore
 * turn a cosmetic problem into an outage.
 */
async function runMaintenance(): Promise<void> {
	try {
		// Agent status records whether a live WebSocket exists, and that lives in memory. After
		// a restart nothing is connected, so a row still claiming ONLINE is a lie that would
		// show the operator a printer they cannot reach.
		const { count } = await prisma.agent.updateMany({
			where: { status: "ONLINE" },
			data: { status: "OFFLINE" },
		});
		if (count > 0) {
			logger.info("Reset stale agent connection state at startup", { count });
		}
	} catch (error) {
		logger.error("Could not reset agent connection state at startup", error);
	}

	try {
		const purged = await purgeExpiredPairingCodes();
		if (purged > 0) {
			logger.info("Purged expired pairing codes at startup", { count: purged });
		}
	} catch (error) {
		logger.error("Could not purge expired pairing codes at startup", error);
	}
}

/**
 * Attaches the agent link endpoint to the running HTTP server.
 *
 * Unlike the maintenance above, a failure here is worth shouting about: without the link no
 * agent can connect and nothing prints. It still does not stop the server, because the panel
 * stays usable and an operator needs it to see what is wrong.
 */
function attachLink(): void {
	const server = getHttpServer();

	if (!server) {
		// Reached when the app is started with `next start` rather than the project entry
		// point. Saying so plainly beats leaving agents unable to connect for unclear reasons.
		logger.error(
			"No HTTP server was published, so the agent link is unavailable. Start with `pnpm start`, not `next start`.",
		);
		return;
	}

	try {
		attachAgentLink(server);
		// Published on the server object so the entry point, which cannot import server-only
		// modules, can still close connections during shutdown.
		Object.assign(server, { fenposCloseLinks: shutdownAgentLinks });
	} catch (error) {
		logger.error("Could not attach the agent link endpoint", error);
	}
}

/**
 * Starts the recurring pass that sends due webhook deliveries.
 *
 * Guarded the way `runMaintenance` guards its own steps: never fatal, a failure logged rather than
 * thrown, because a webhook that cannot be delivered must never stop the server from serving.
 * `deliverDue` already promises never to throw — its own module comment covers why — but that
 * promise is not this function's to rely on; a timer with nobody to catch a rejection needs its own
 * guard regardless of how careful the thing it calls already is.
 *
 * A pass is skipped, not queued, while the previous one is still running. `deliverDue` tolerates
 * overlapping passes by design — see the lease in `lib/webhooks/deliver.ts` — but stacking passes
 * against a slow target wastes work and only widens the window that lease has to cover, for no
 * benefit: the next tick five seconds later will pick up whatever the running one has not yet
 * reached.
 *
 * `unref()`'d, like the DNS race timer in `lib/webhooks/deliver.ts`'s `rejectAfter`, so this
 * interval can never by itself hold the process open at shutdown.
 */
function startDeliveryDrain(): void {
	let running = false;

	const timer = setInterval(() => {
		if (running) {
			return;
		}
		running = true;
		deliverDue()
			.catch((error) => {
				logger.error("A webhook delivery pass could not run", error);
			})
			.finally(() => {
				running = false;
			});
	}, DELIVERY_DRAIN_INTERVAL_MS);

	timer.unref();
}

/**
 * Starts the recurring pass that sweeps both record databases back inside their retention windows.
 *
 * The log lines an agent forwarded and the audit record, each archived and removed a whole period at
 * a time by `lib/maintenance/pass.ts`. This is the only thing that triggers either: retention used to
 * run on the way out of a write, which meant an install that stopped writing stopped sweeping, and
 * meant a print request paid for whatever a sweep did.
 *
 * A pass is skipped, not queued, while the previous one is still running — the same rule the delivery
 * drain above follows, and it matters more here. Archiving opens a database, copies a period, verifies
 * it and gzips it, so a pass can genuinely outlast an hour on a large period; a second one started on
 * top would be two rotations racing over one period's archive file, and the next tick an hour later
 * picks up whatever the running one has not reached anyway.
 *
 * Guarded and `unref()`'d for the reasons {@link startDeliveryDrain} gives. `runMaintenancePass`
 * already promises never to throw, and as there, that promise is not this function's to rely on.
 *
 * Exported so the skip-while-running guard above can be driven directly by a test, in the way
 * `lib/webhooks/deliver.ts` exports `sweepDeliveriesNow`; {@link registerRuntime} is its only caller
 * in the running server.
 */
export function startMaintenance(): void {
	let running = false;

	const timer = setInterval(() => {
		if (running) {
			return;
		}
		running = true;
		runMaintenancePass()
			.catch((error) => {
				logger.error("A maintenance pass could not run", error);
			})
			.finally(() => {
				running = false;
			});
	}, MAINTENANCE_INTERVAL_MS);

	timer.unref();
}
