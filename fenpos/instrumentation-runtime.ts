import { purgeExpiredPairingCodes } from "@/lib/agents/pairing";
import { ensureAdminPassword } from "@/lib/auth/admin";
import { purgeExpiredSessions } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { attachAgentLink, shutdownAgentLinks } from "@/lib/link/link-server";
import { getHttpServer } from "@/lib/link/server-handle";
import { logger } from "@/lib/logger";
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
 * Startup work for the Node.js runtime.
 *
 * Reached only through the guard in instrumentation.ts, so imports here may freely use
 * Node.js built-ins and the database. Keeping them out of that module is what stops the edge
 * bundle pulling in Prisma and failing to compile.
 */
export async function registerRuntime(): Promise<void> {
	await announceAdminPassword();
	await runMaintenance();
	// Seeds modules that hold a mutable value pushed from the store — the logger's minimum
	// level today — with whatever is saved. Placed after the maintenance queries above so it
	// runs once the database has already proven reachable, rather than being the first query
	// attempted at startup.
	await applyPushedSettings();
	attachLink();
	startDeliveryDrain();
}

/**
 * Prints the generated administrator password, creating it on the first boot that needs one.
 *
 * Repeated on every start for as long as that password is still in use, rather than shown
 * once. An operator who scrolled past it, restarted before signing in, or came to a container
 * whose first logs have rotated away would otherwise have no route in but to reset the
 * install. It stops appearing the moment a real password is set, so it cannot become
 * background noise nobody reads.
 *
 * Written straight to stdout rather than through the logger, and framed, because it is the
 * one thing in the output an operator must not miss.
 *
 * A failure here blocks sign-in but not serving, so it is reported rather than thrown: the
 * logs explaining what went wrong are easier to reach with the server up.
 */
async function announceAdminPassword(): Promise<void> {
	try {
		const password = await ensureAdminPassword();
		if (!password) {
			return;
		}

		const rule = "─".repeat(66);
		process.stdout.write(
			`\n${rule}\n` +
				`  This install is still using its generated administrator password:\n\n` +
				`      ${password}\n\n` +
				`  Sign in with it. FenPOS will ask you to replace it before letting you\n` +
				`  into the panel, and this message stops once you have.\n` +
				`${rule}\n\n`,
		);
	} catch (error) {
		logger.error("Could not read or create the administrator password", error);
	}
}

/**
 * One-time housekeeping at boot.
 *
 * Every step is individually guarded and none is fatal. None of this is required for the
 * server to serve correctly — expiry is enforced on the read path, and a stale agent status
 * corrects itself as soon as that agent reconnects — so refusing to start over a housekeeping
 * error would turn a cosmetic problem into an outage.
 */
async function runMaintenance(): Promise<void> {
	try {
		const purged = await purgeExpiredSessions();
		if (purged > 0) {
			logger.info("Purged expired sessions at startup", { count: purged });
		}
	} catch (error) {
		logger.error("Could not purge expired sessions at startup", error);
	}

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
