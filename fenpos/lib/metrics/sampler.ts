import "server-only";
import { statSync } from "node:fs";
import { metricsDb, prisma } from "@/lib/db";
import { AUDIT_DATABASE_URL, env, LOGS_DATABASE_URL } from "@/lib/env";
import { getAgentStatus } from "@/lib/link/device-status";
import { connectedAgentIds } from "@/lib/link/registry";
import { logger } from "@/lib/logger";
import { globalStatsSettings } from "@/lib/settings/settings-service";

/**
 * Takes one snapshot of the fleet's availability, queues, sessions and storage and writes it as
 * one `FleetSample` row.
 *
 * Every count is read fresh from its own source of truth rather than derived from another sample,
 * so a gap in sampling — the master switch off for a while, or the process down — never corrupts a
 * later row: each sample stands on its own.
 *
 * `agentsOnline` and `devicesConnected` come from in-memory state ({@link connectedAgentIds},
 * {@link getAgentStatus}), not the database, for the same reason `lib/link/registry.ts` and
 * `lib/link/device-status.ts` themselves are in-memory: a socket cannot outlive the process that
 * holds it, so only the running server can say what is connected right now.
 *
 * @param now the sample's timestamp, and what `activeSessions` is measured against; defaults to
 *   the current time, overridable so a test can pin the row it asserts on
 */
export async function takeFleetSample(now: Date = new Date()): Promise<void> {
	const online = new Set(connectedAgentIds());

	const [agentsTotal, devices, queueDepth, pendingWebhooks, activeSessions] = await Promise.all([
		prisma.agent.count(),
		prisma.device.findMany({ select: { agentId: true, name: true } }),
		prisma.job.count({ where: { status: { in: ["QUEUED", "PRINTING"] } } }),
		prisma.webhookDelivery.count({ where: { status: "PENDING" } }),
		prisma.session.count({ where: { expiresAt: { gt: now } } }),
	]);

	const devicesConnected = devices.filter(
		(device) => getAgentStatus(device.agentId).get(device.name)?.connection === "CONNECTED",
	).length;

	await metricsDb.fleetSample.create({
		data: {
			at: now,
			agentsTotal,
			agentsOnline: online.size,
			devicesTotal: devices.length,
			devicesConnected,
			queueDepth,
			pendingWebhooks,
			activeSessions,
			dbMainBytes: fileSizeOf(env.DATABASE_URL),
			dbAuditBytes: fileSizeOf(AUDIT_DATABASE_URL),
			dbLogsBytes: fileSizeOf(LOGS_DATABASE_URL),
		},
	});
}

/**
 * The size of a `file:`-prefixed SQLite database, or 0 when it cannot be read.
 *
 * A missing or unreadable file is not a sampling failure — an install that has not yet created a
 * sibling database (say, before its first log line) still gets a sample, just with that figure at
 * zero, rather than losing the whole row.
 *
 * @param fileUrl a `file:` URL, e.g. `file:./data/fenpos.db`
 * @returns the file's size in bytes, or 0 if it could not be stat'd
 */
function fileSizeOf(fileUrl: string): number {
	try {
		const path = fileUrl.replace(/^file:/, "");
		return statSync(path).size;
	} catch {
		return 0;
	}
}

/**
 * Starts the recurring pass that takes a fleet sample.
 *
 * A self-rescheduling `setTimeout` rather than `setInterval`, unlike `startMetricsFlusher` and
 * `startMaintenance` in `instrumentation-runtime.ts`: the timer is only re-armed once a tick has
 * finished, reading `stats.sampleIntervalSeconds` fresh each time, so a changed interval setting
 * takes effect within one cycle rather than waiting for the process to restart.
 *
 * Skips taking a sample while `stats.enabled` is off, but still re-arms — so the timer keeps
 * ticking at the configured cadence and picks the sampler back up the moment the switch flips on,
 * rather than needing a restart to resume.
 *
 * `unref()`'d and guarded with try/catch, following the same convention as every other recurring
 * pass in `instrumentation-runtime.ts`: never fatal, and never holds the process open on its own.
 */
export function startFleetSampler(): void {
	const tick = (): void => {
		(async () => {
			const stats = await globalStatsSettings();
			if (stats.enabled) {
				await takeFleetSample();
			}
			return stats.sampleIntervalSeconds;
		})()
			.catch((error) => {
				logger.error("A fleet sample could not be taken", error);
				return undefined;
			})
			.then((sampleIntervalSeconds) => {
				const timer = setTimeout(tick, (sampleIntervalSeconds ?? 300) * 1000);
				timer.unref();
			});
	};

	tick();
}
