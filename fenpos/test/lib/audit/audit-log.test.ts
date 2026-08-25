import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordAudit, SETUP_ACTOR, SYSTEM_ACTOR, unknownUserActor, userActor } from "@/lib/audit/audit-log";
import { GENESIS_HASH, hashEvent } from "@/lib/audit/chain";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { REDACTION_MARKER } from "@/lib/redact";

/**
 * The only writer.
 *
 * Two properties matter more than the row's contents. It never throws — an action refused because
 * its audit row would not store is a worse outcome than a lost row, and an action that happened and
 * then threw on the way out is worse than both. And two concurrent writers cannot fork the chain,
 * because the database refuses the second and this retries it against the row the first wrote.
 */
describe("recordAudit", () => {
	beforeEach(async () => {
		await prisma.auditEvent.deleteMany({});
		await prisma.auditAnchor.deleteMany({});
		vi.restoreAllMocks();
	});

	it("starts the chain at genesis", async () => {
		await recordAudit({ action: "test:first", outcome: "SUCCESS", actor: SYSTEM_ACTOR });

		const row = await prisma.auditEvent.findFirstOrThrow({ orderBy: { seq: "asc" } });
		expect(row.prevHash).toBe(GENESIS_HASH);
		expect(row.actorKind).toBe("SYSTEM");
		expect(row.action).toBe("test:first");
	});

	it("links each row to the one before it", async () => {
		await recordAudit({ action: "test:one", outcome: "SUCCESS", actor: SYSTEM_ACTOR });
		await recordAudit({ action: "test:two", outcome: "SUCCESS", actor: SYSTEM_ACTOR });

		const rows = await prisma.auditEvent.findMany({ orderBy: { seq: "asc" } });
		expect(rows[1].prevHash).toBe(rows[0].hash);
	});

	it("writes a hash that recomputes from the stored row", async () => {
		await recordAudit({
			action: "test:hash",
			outcome: "SUCCESS",
			actor: userActor({ id: "u1", name: "Owner", email: "owner@example.com" }),
		});

		// `row` is passed as a variable rather than as an object literal: it carries `seq`, `prevHash`
		// and `hash` on top of the sixteen covered fields, and excess-property checking would object
		// to a literal. `canonicalise` reads only the names it declares, so the extras are ignored.
		const row = await prisma.auditEvent.findFirstOrThrow();
		expect(hashEvent(row, row.prevHash)).toBe(row.hash);
	});

	it("names the account on a refused sign-in even though no user is known", async () => {
		await recordAudit({
			action: "auth:sign-in",
			outcome: "DENIED",
			actor: unknownUserActor("stranger@example.com"),
		});

		const row = await prisma.auditEvent.findFirstOrThrow();
		expect(row.actorKind).toBe("USER");
		expect(row.actorUserId).toBeNull();
		expect(row.actorEmail).toBe("stranger@example.com");
	});

	it("redacts a secret that reached detail anyway", async () => {
		await recordAudit({
			action: "setup:complete",
			outcome: "SUCCESS",
			actor: SETUP_ACTOR,
			detail: { email: "owner@example.com", setupKey: "AAAA-BBBB-CCCC" },
		});

		const row = await prisma.auditEvent.findFirstOrThrow();
		const detail = JSON.parse(row.detail as string) as Record<string, unknown>;
		expect(detail.email).toBe("owner@example.com");
		expect(detail.setupKey).toBe(REDACTION_MARKER);
	});

	it("does not throw when the write fails, and says so in the log", async () => {
		const failed = vi.spyOn(logger, "error").mockImplementation(() => undefined);
		vi.spyOn(prisma.auditEvent, "create").mockRejectedValue(new Error("disk is full"));

		await expect(
			recordAudit({ action: "test:doomed", outcome: "SUCCESS", actor: SYSTEM_ACTOR }),
		).resolves.toBeUndefined();

		expect(failed).toHaveBeenCalled();
	});

	it("does not throw when detail cannot be serialised", async () => {
		const failed = vi.spyOn(logger, "error").mockImplementation(() => undefined);

		// A BigInt makes JSON.stringify throw. The point is not that anyone would pass one, but that
		// the writer's promise holds for a caller's mistake as well as for a database failure.
		// Written as `BigInt(1)` rather than the `1n` literal because this project targets ES2017,
		// under which the literal syntax does not compile; the value is the same either way.
		await expect(
			recordAudit({ action: "test:bigint", outcome: "SUCCESS", actor: SYSTEM_ACTOR, detail: { size: BigInt(1) } }),
		).resolves.toBeUndefined();

		expect(failed).toHaveBeenCalled();
	});

	it("retries a concurrent write instead of forking the chain", async () => {
		// Both calls read the same tail before either inserts, so the second loses the unique
		// constraint on prev_hash and must retry against the row the first wrote.
		await Promise.all([
			recordAudit({ action: "test:racer-a", outcome: "SUCCESS", actor: SYSTEM_ACTOR }),
			recordAudit({ action: "test:racer-b", outcome: "SUCCESS", actor: SYSTEM_ACTOR }),
		]);

		const rows = await prisma.auditEvent.findMany({ orderBy: { seq: "asc" } });
		expect(rows).toHaveLength(2);
		expect(rows[0].prevHash).toBe(GENESIS_HASH);
		expect(rows[1].prevHash).toBe(rows[0].hash);
	});
});
