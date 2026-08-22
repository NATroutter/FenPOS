import "server-only";
import { generatePairingCode, generateToken, hashSecret, normalizePairingCode } from "@/lib/auth/secrets";
import { prisma } from "@/lib/db";
import { integerSetting } from "@/lib/settings/settings-service";

/**
 * Agent pairing: issuing a short-lived code, and exchanging it for a long-lived token.
 *
 * A pairing code is the one moment the system accepts an unauthenticated caller claiming an
 * identity, so the guarantees here are what the whole link rests on. The code is single-use,
 * expires quickly, and is consumed atomically at redemption rather than at first connect —
 * so a code observed in flight cannot be replayed by whoever saw it.
 *
 * Rate limiting is applied at the route, not here, because it depends on the caller's
 * address and this module deliberately knows nothing about HTTP.
 */

/**
 * How long a freshly issued pairing code remains redeemable, in milliseconds.
 *
 * Reads `pairing.codeMinutes` (`settings-service.ts`) on every call rather than caching it, so
 * a change to the setting takes effect on the very next code issued rather than needing a
 * restart. Long enough to walk the code to the machine, short enough that a code left on a
 * screen is not a standing invitation.
 *
 * @returns the configured lifetime, in milliseconds
 */
async function pairingCodeTtlMs(): Promise<number> {
	return (await integerSetting("pairing.codeMinutes")) * 60_000;
}

/** What a agent learns by successfully redeeming a code. */
export interface PairingGrant {
	agentId: string;
	agentName: string;
	/** The bearer token, returned exactly once. Only its hash is stored. */
	token: string;
}

/**
 * Why a redemption failed.
 *
 * Distinguished here so the server log can say what happened. The HTTP layer collapses all
 * of these into one response: telling a caller whether a code was wrong, expired, or already
 * used would let them probe the code space for near-misses.
 */
export type PairingFailure = "malformed" | "unknown" | "expired" | "consumed";

/** Outcome of a redemption attempt. */
export type PairingResult = { ok: true; grant: PairingGrant } | { ok: false; failure: PairingFailure };

/** Details a agent reports about itself while pairing. Untrusted, stored for display only. */
export interface AgentSelfReport {
	agentVersion?: string | null;
	platform?: string | null;
	hostname?: string | null;
	address?: string | null;
}

/**
 * Issues a pairing code for a agent, replacing any code it already has.
 *
 * Only one code is outstanding per agent at a time. Leaving older codes redeemable would
 * multiply the guessable surface every time an operator clicked regenerate, and would let a
 * code the operator believed they had replaced still pair a device.
 *
 * @param agentId the agent to issue for
 * @param now current time; injectable for tests
 * @returns the formatted code and its expiry
 */
export async function issuePairingCode(
	agentId: string,
	now: Date = new Date(),
): Promise<{ code: string; expiresAt: Date }> {
	const code = generatePairingCode();
	const expiresAt = new Date(now.getTime() + (await pairingCodeTtlMs()));

	await prisma.$transaction([
		prisma.pairingCode.deleteMany({ where: { agentId, consumedAt: null } }),
		prisma.pairingCode.create({ data: { agentId, code, createdAt: now, expiresAt } }),
	]);

	return { code, expiresAt };
}

/**
 * Exchanges a pairing code for a agent token.
 *
 * The code is consumed with a conditional update that only matches while `consumedAt` is
 * still null. Two simultaneous redemptions therefore cannot both succeed: whichever update
 * matches first wins, and the loser sees zero rows affected and is rejected. Checking and
 * then writing would leave a window where both callers observed an unconsumed code.
 *
 * @param rawCode the code as typed by the operator, in any case or grouping
 * @param report what the agent says about itself; recorded for display, never trusted
 * @param now current time; injectable for tests
 * @returns the grant, or why redemption was refused
 */
export async function redeemPairingCode(
	rawCode: string,
	report: AgentSelfReport = {},
	now: Date = new Date(),
): Promise<PairingResult> {
	const code = normalizePairingCode(rawCode);
	if (!code) {
		return { ok: false, failure: "malformed" };
	}

	const existing = await prisma.pairingCode.findUnique({
		where: { code },
		select: { id: true, agentId: true, expiresAt: true, consumedAt: true },
	});

	if (!existing) {
		return { ok: false, failure: "unknown" };
	}
	if (existing.consumedAt !== null) {
		return { ok: false, failure: "consumed" };
	}
	if (existing.expiresAt <= now) {
		return { ok: false, failure: "expired" };
	}

	const token = generateToken();

	try {
		const agent = await prisma.$transaction(async (tx) => {
			// The guard on consumedAt is what makes this single-use under concurrency. The
			// expiry is re-checked here too, so a code cannot be redeemed by a request that
			// read it microseconds before it lapsed.
			const claimed = await tx.pairingCode.updateMany({
				where: { id: existing.id, consumedAt: null, expiresAt: { gt: now } },
				data: { consumedAt: now },
			});

			if (claimed.count !== 1) {
				return null;
			}

			return tx.agent.update({
				where: { id: existing.agentId },
				data: {
					status: "OFFLINE",
					tokenHash: hashSecret(token),
					agentVersion: report.agentVersion ?? null,
					platform: report.platform ?? null,
					hostname: report.hostname ?? null,
					lastAddress: report.address ?? null,
				},
				select: { id: true, name: true },
			});
		});

		if (!agent) {
			return { ok: false, failure: "consumed" };
		}

		return { ok: true, grant: { agentId: agent.id, agentName: agent.name, token } };
	} catch (error) {
		// The agent row disappearing mid-transaction means it was deleted while the code was
		// being redeemed. That is a legitimate race, not a fault: the operator removed the
		// agent, and the pairing should simply fail.
		if (isMissingRecordError(error)) {
			return { ok: false, failure: "unknown" };
		}
		throw error;
	}
}

/**
 * Whether an error is Prisma reporting that a row to update did not exist.
 *
 * Matched on the code rather than the message so a wording change upstream cannot silently
 * turn this into a swallowed unrelated failure.
 *
 * @param error the caught value
 * @returns true when the error is Prisma's "record not found"
 */
function isMissingRecordError(error: unknown): boolean {
	return (
		typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "P2025"
	);
}

/**
 * Removes pairing codes that can no longer be redeemed.
 *
 * Consumed codes are retained: they are the record of when a agent was paired and from where,
 * which is the audit trail an operator needs if a agent appears that they did not expect.
 *
 * @param now current time; injectable for tests
 * @returns how many rows were removed
 */
export async function purgeExpiredPairingCodes(now: Date = new Date()): Promise<number> {
	const { count } = await prisma.pairingCode.deleteMany({
		where: { consumedAt: null, expiresAt: { lte: now } },
	});
	return count;
}
