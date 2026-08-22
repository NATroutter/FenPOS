import { beforeEach, describe, expect, it } from "vitest";
import { issuePairingCode, purgeExpiredPairingCodes, redeemPairingCode } from "@/lib/agents/pairing";
import { hashSecret } from "@/lib/auth/secrets";
import { prisma } from "@/lib/db";
import { setSetting } from "@/lib/settings/settings-service";

/**
 * Pairing is the only point at which an unauthenticated caller can claim an identity, so
 * these tests are mostly about the ways redemption must fail.
 */
describe("pairing", () => {
	const now = new Date("2026-08-18T10:00:00.000Z");

	/**
	 * The `pairing.codeMinutes` fallback (`settings-service.ts`), in milliseconds, for tests
	 * that leave it unset.
	 */
	const DEFAULT_CODE_TTL_MS = 15 * 60_000;

	async function createAgent(name = "kitchen") {
		return prisma.agent.create({ data: { name }, select: { id: true, name: true } });
	}

	beforeEach(async () => {
		await prisma.pairingCode.deleteMany({});
		await prisma.agent.deleteMany({});
		await prisma.setting.deleteMany({ where: { key: "pairing.codeMinutes" } });
	});

	describe("issuePairingCode", () => {
		it("issues a formatted code with the default lifetime", async () => {
			const agent = await createAgent();
			const { code, expiresAt } = await issuePairingCode(agent.id, now);

			expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
			expect(expiresAt.getTime()).toBe(now.getTime() + DEFAULT_CODE_TTL_MS);
		});

		it("honours a configured pairing code lifetime, both for issuing and for expiry", async () => {
			await setSetting("pairing.codeMinutes", 1);
			const agent = await createAgent();
			const { code, expiresAt } = await issuePairingCode(agent.id, now);

			expect(expiresAt.getTime()).toBe(now.getTime() + 60_000);

			// The configured lifetime must actually reach redemption, not just the stored row:
			// a code that would still be valid under the 15-minute default must be refused once
			// the shorter configured lifetime has elapsed.
			const stillWithinDefault = new Date(now.getTime() + 61_000);
			const result = await redeemPairingCode(code, {}, stillWithinDefault);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.failure).toBe("expired");
		});

		it("replaces an outstanding code rather than adding a second", async () => {
			const agent = await createAgent();
			const first = await issuePairingCode(agent.id, now);
			const second = await issuePairingCode(agent.id, now);

			expect(await prisma.pairingCode.count({ where: { agentId: agent.id } })).toBe(1);
			// The replaced code must stop working, or regenerating would widen the surface
			// instead of rotating it.
			expect((await redeemPairingCode(first.code, {}, now)).ok).toBe(false);
			expect((await redeemPairingCode(second.code, {}, now)).ok).toBe(true);
		});

		it("retains consumed codes when reissuing, preserving the audit trail", async () => {
			const agent = await createAgent();
			const first = await issuePairingCode(agent.id, now);
			await redeemPairingCode(first.code, {}, now);
			await issuePairingCode(agent.id, now);

			expect(await prisma.pairingCode.count({ where: { agentId: agent.id } })).toBe(2);
		});
	});

	describe("redeemPairingCode", () => {
		it("grants a token and records the agent as paired", async () => {
			const agent = await createAgent();
			const { code } = await issuePairingCode(agent.id, now);

			const result = await redeemPairingCode(code, { hostname: "kitchen-pi", platform: "linux" }, now);

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.grant.agentId).toBe(agent.id);
				expect(result.grant.token).toHaveLength(43);
			}

			const stored = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } });
			expect(stored.status).toBe("OFFLINE");
			expect(stored.hostname).toBe("kitchen-pi");
		});

		it("stores only the hash of the token", async () => {
			const agent = await createAgent();
			const { code } = await issuePairingCode(agent.id, now);
			const result = await redeemPairingCode(code, {}, now);

			if (!result.ok) throw new Error("expected success");
			const stored = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } });
			expect(stored.tokenHash).toBe(hashSecret(result.grant.token));
			expect(stored.tokenHash).not.toBe(result.grant.token);
		});

		it("accepts a code typed in any case or grouping", async () => {
			const agent = await createAgent();
			const { code } = await issuePairingCode(agent.id, now);

			const typed = code.toLowerCase().replace(/-/g, " ");
			expect((await redeemPairingCode(typed, {}, now)).ok).toBe(true);
		});

		it("refuses a second redemption of the same code", async () => {
			const agent = await createAgent();
			const { code } = await issuePairingCode(agent.id, now);

			expect((await redeemPairingCode(code, {}, now)).ok).toBe(true);

			const second = await redeemPairingCode(code, {}, now);
			expect(second.ok).toBe(false);
			if (!second.ok) expect(second.failure).toBe("consumed");
		});

		it("refuses an expired code", async () => {
			const agent = await createAgent();
			const { code } = await issuePairingCode(agent.id, now);

			const late = new Date(now.getTime() + DEFAULT_CODE_TTL_MS + 1);
			const result = await redeemPairingCode(code, {}, late);

			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.failure).toBe("expired");
		});

		it("refuses a code at the exact moment it expires", async () => {
			const agent = await createAgent();
			const { code } = await issuePairingCode(agent.id, now);

			const atExpiry = new Date(now.getTime() + DEFAULT_CODE_TTL_MS);
			expect((await redeemPairingCode(code, {}, atExpiry)).ok).toBe(false);
		});

		it("refuses an unknown code", async () => {
			const result = await redeemPairingCode("AAAA-BBBB-CCCC", {}, now);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.failure).toBe("unknown");
		});

		it("refuses a malformed code without querying", async () => {
			const result = await redeemPairingCode("nope", {}, now);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.failure).toBe("malformed");
		});

		it("grants exactly one token when redeemed concurrently", async () => {
			const agent = await createAgent();
			const { code } = await issuePairingCode(agent.id, now);

			// The whole point of consuming atomically: two agents racing on one code must not
			// both end up believing they own the identity.
			const results = await Promise.all([
				redeemPairingCode(code, {}, now),
				redeemPairingCode(code, {}, now),
				redeemPairingCode(code, {}, now),
			]);

			expect(results.filter((result) => result.ok)).toHaveLength(1);
		});

		it("leaves the agent unpaired when redemption fails", async () => {
			const agent = await createAgent();
			await issuePairingCode(agent.id, now);

			await redeemPairingCode("AAAA-BBBB-CCCC", {}, now);

			const stored = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } });
			expect(stored.tokenHash).toBeNull();
			expect(stored.status).toBe("PENDING");
		});
	});

	describe("purgeExpiredPairingCodes", () => {
		it("removes lapsed codes but keeps consumed ones", async () => {
			const lapsed = await createAgent("lapsed");
			const paired = await createAgent("paired");

			await issuePairingCode(lapsed.id, now);
			const active = await issuePairingCode(paired.id, now);
			await redeemPairingCode(active.code, {}, now);

			const later = new Date(now.getTime() + DEFAULT_CODE_TTL_MS + 1);
			expect(await purgeExpiredPairingCodes(later)).toBe(1);
			expect(await prisma.pairingCode.count()).toBe(1);
		});
	});
});
