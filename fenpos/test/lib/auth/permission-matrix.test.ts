import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Every gated action, held to the same three answers.
 *
 * The fourth of the spec's load-bearing tests. `registry-coverage.test.ts` proves nothing escapes
 * the registry; this proves the registry is worth escaping — that an entry's permission is actually
 * consulted, for every entry, rather than for the handful anybody wrote a test for.
 *
 * It drives `panelAction` with a spy body rather than calling each real action. Sixty real bodies
 * would mean sixty sets of fixtures and would be testing sixty services; the rule they share is the
 * gate, and a spy body is what makes the gate the only variable.
 *
 * A fresh account id per case, because `effectivePermissions` memoises per id for the life of the
 * process — see the Global Constraints. The counter below is what guarantees that.
 */
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/request-context", () => ({
	getClientAddress: async () => "203.0.113.50",
	getUserAgent: async () => "vitest",
}));

const currentSessionUser = vi.fn();
vi.mock("@/lib/auth/require-session", () => ({
	requireSession: async () => currentSessionUser(),
	// No session ever rotates in this file's actions, so the audit row's session id is whatever
	// `panel-action.ts`'s `record()` was already carrying — see `currentSessionId`'s own doc.
	currentSessionId: async (fallback: string) => fallback,
}));

const { panelAction } = await import("@/lib/auth/panel-action");
const { PANEL_ACTIONS } = await import("@/lib/auth/panel-actions");
const { REFUSAL_MESSAGE } = await import("@/lib/auth/require-permission");
const { prisma } = await import("@/lib/db");

/** Every entry the gate actually checks a permission for. */
const gated = PANEL_ACTIONS.filter((entry) => entry.kind === "command" || entry.kind === "query");

let nextAccount = 0;

/** A fresh account, with an id no earlier case can have memoised. */
async function account(isSuperuser = false) {
	nextAccount += 1;
	const id = `matrix-${nextAccount}`;
	await prisma.user.create({ data: { id, name: id, email: `${id}@example.com`, isSuperuser } });
	return { id, name: id, email: `${id}@example.com`, isSuperuser, mustChangePassword: false };
}

beforeEach(async () => {
	await prisma.auditEvent.deleteMany({});
	await prisma.userPermission.deleteMany({});
	await prisma.userRole.deleteMany({});
	await prisma.rolePermission.deleteMany({});
	await prisma.role.deleteMany({});
	await prisma.session.deleteMany({});
	await prisma.account.deleteMany({});
	await prisma.user.deleteMany({});
	currentSessionUser.mockReset();
});

describe("permission matrix", () => {
	it("checks a permission for every command and query, and for nothing else", () => {
		// A guard on the matrix itself: a filter that silently matched nothing would pass every case
		// below while proving nothing at all.
		expect(gated.length).toBeGreaterThanOrEqual(50);
		for (const entry of gated) {
			expect(entry.permission).not.toBeNull();
		}
	});

	for (const entry of gated) {
		describe(entry.id, () => {
			it("refuses a caller who does not hold it, and records the refusal", async () => {
				const user = await account();
				currentSessionUser.mockResolvedValue(user);
				const body = vi.fn().mockResolvedValue(undefined);

				const result = await panelAction(entry.id, body);

				expect(result.error).toBe(REFUSAL_MESSAGE);
				expect(body).not.toHaveBeenCalled();

				// Permission probing has to be visible in the record. This is the assertion that makes
				// it so for every action rather than for the one somebody tested.
				const row = await prisma.auditEvent.findFirstOrThrow({ orderBy: { seq: "desc" } });
				expect(row.action).toBe(entry.id);
				expect(row.outcome).toBe("DENIED");
				expect(row.detail).toContain(entry.permission);
			});

			it("allows a caller who holds it", async () => {
				const user = await account();
				await prisma.userPermission.create({ data: { userId: user.id, permission: entry.permission as string } });
				currentSessionUser.mockResolvedValue(user);
				const body = vi.fn().mockResolvedValue(undefined);

				const result = await panelAction(entry.id, body);

				// `users:set-superuser` is the deliberate exception, and it is the reason this assertion
				// reads the way it does rather than expecting `null` outright: it is in NEVER_GRANTABLE,
				// so the row written above confers nothing and the caller is still refused. Anything
				// else being refused here means an entry's permission is not the one the gate checks.
				const grantable = entry.permission !== "users:set-superuser";
				expect(result.error).toBe(grantable ? null : REFUSAL_MESSAGE);
				expect(body).toHaveBeenCalledTimes(grantable ? 1 : 0);
			});

			it("allows a superuser, who holds no row at all", async () => {
				const user = await account(true);
				currentSessionUser.mockResolvedValue(user);
				const body = vi.fn().mockResolvedValue(undefined);

				const result = await panelAction(entry.id, body);

				expect(result.error).toBeNull();
				expect(body).toHaveBeenCalledTimes(1);
			});
		});
	}
});
