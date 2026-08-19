import { purgeExpiredPairingCodes } from "@/lib/agents/pairing";
import { ensureAdminPassword } from "@/lib/auth/admin";
import { purgeExpiredSessions } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { attachAgentLink, shutdownAgentLinks } from "@/lib/link/link-server";
import { getHttpServer } from "@/lib/link/server-handle";
import { logger } from "@/lib/logger";

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
	attachLink();
}

/**
 * Creates the administrator password on first boot and prints it once.
 *
 * Written straight to stdout rather than through the logger, and framed, because this is the
 * one line an operator must not scroll past — it is the only time the password is ever
 * visible, and everything else about the install is unreachable without it.
 *
 * A failure here is fatal to sign-in but not to serving, so it is reported rather than
 * thrown: an operator needs the panel up to read the logs that explain what went wrong.
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
				`  FenPOS generated an administrator password for this install:\n\n` +
				`      ${password}\n\n` +
				`  Sign in with it, then change it under Settings. It is shown here\n` +
				`  once and is not recoverable — the database keeps only its hash.\n` +
				`${rule}\n\n`,
		);
	} catch (error) {
		logger.error("Could not create the administrator password", error);
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
