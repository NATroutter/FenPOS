import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The one place that decides whether a panel action may proceed.
 *
 * Three properties are worth more than the return value. A caller without the permission is
 * refused and the refusal is recorded — permission probing must be visible. A superuser proceeds
 * without holding anything. And an action that threw is recorded as `FAILURE` rather than
 * vanishing, because an attempt that failed is as much a part of the record as one that worked.
 */
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/request-context", () => ({
	getClientAddress: async () => "203.0.113.50",
	getUserAgent: async () => "vitest",
}));

const currentSessionUser = vi.fn();
// Identity by default — record() asks for the live session id and gets back exactly the fallback it
// was given, matching a request whose session was never rotated. The one test below that overrides
// this proves record() actually uses what it is handed rather than always falling back to
// `user.sessionId`, which is `currentSessionId`'s own behaviour and is proved for real in
// `require-session.test.ts` — this file only has to prove `record()` calls it and uses the answer.
const liveSessionId = vi.fn(async (fallback: string) => fallback);
vi.mock("@/lib/auth/require-session", () => ({
	requireSession: async (options?: { skipEnrolmentGate?: boolean }) => currentSessionUser(options),
	currentSessionId: async (fallback: string) => liveSessionId(fallback),
}));

const { panelAction, panelQuery, panelSelf } = await import("@/lib/auth/panel-action");
const { REFUSAL_MESSAGE } = await import("@/lib/auth/require-permission");
const { auditDb, prisma } = await import("@/lib/db");
const { ApiError } = await import("@/lib/errors");

/** An account row, so `effectivePermissions` has something real to read. */
async function account(id: string, isSuperuser = false) {
	await prisma.user.create({ data: { id, name: `User ${id}`, email: `${id}@example.com`, isSuperuser } });
	return {
		id,
		name: `User ${id}`,
		email: `${id}@example.com`,
		isSuperuser,
		mustChangePassword: false,
		sessionId: `session-${id}`,
		twoFactorEnabled: false,
	};
}

/** The shape `previewMoment` reports, named so the generic is not inferred from one literal. */
interface Preview {
	text: string | null;
	error: string | null;
}

/** The shape a key mint reports. */
interface Minted {
	error: string | null;
	secret: string | null;
}

/** The most recent audit row. */
async function lastEvent() {
	return auditDb.auditEvent.findFirstOrThrow({ orderBy: { seq: "desc" } });
}

async function reset() {
	await auditDb.auditEvent.deleteMany({});
	await prisma.userPermission.deleteMany({});
	await prisma.userRole.deleteMany({});
	await prisma.rolePermission.deleteMany({});
	await prisma.role.deleteMany({});
	await prisma.session.deleteMany({});
	await prisma.account.deleteMany({});
	await prisma.user.deleteMany({});
	currentSessionUser.mockReset();
	liveSessionId.mockReset().mockImplementation(async (fallback: string) => fallback);
}

describe("panelAction", () => {
	beforeEach(reset);

	it("runs the body and records it when the caller holds the permission", async () => {
		const user = await account("u1");
		await prisma.userPermission.create({ data: { userId: user.id, permission: "agents:delete" } });
		currentSessionUser.mockResolvedValue(user);
		const body = vi.fn().mockResolvedValue(undefined);

		expect(await panelAction("agents:delete", body)).toEqual({ error: null });

		expect(body).toHaveBeenCalled();
		const row = await lastEvent();
		expect(row.action).toBe("agents:delete");
		expect(row.outcome).toBe("SUCCESS");
		expect(row.actorUserId).toBe("u1");
		expect(row.ipAddress).toBe("203.0.113.50");
	});

	it("records the session the action was taken under", async () => {
		const user = await account("s-provenance", true);
		currentSessionUser.mockResolvedValue(user);

		await panelAction("agents:delete", async () => undefined);

		const row = await lastEvent();
		expect(row.sessionId).toBe(user.sessionId);
	});

	/**
	 * `changePassword`, `self:confirm-2fa` and `self:end-2fa` all rotate the caller's own session as
	 * part of their work, so `user.sessionId` — resolved by `gate()` before the body ran — names a row
	 * that no longer exists by the time this writes. `record()` asks `currentSessionId` for the
	 * session the request holds *now* instead of trusting that stale value; this proves it uses the
	 * answer rather than always falling back to `user.sessionId`, which every other test in this file
	 * would still pass even if `record()` ignored it entirely.
	 */
	it("names the session the action rotated onto, not the one the gate resolved", async () => {
		const user = await account("s-rotated", true);
		currentSessionUser.mockResolvedValue(user);
		liveSessionId.mockResolvedValue("rotated-away-from-s-rotated");

		await panelAction("agents:delete", async () => undefined);

		const row = await lastEvent();
		expect(row.sessionId).toBe("rotated-away-from-s-rotated");
		expect(row.sessionId).not.toBe(user.sessionId);
	});

	it("refuses a caller who holds nothing, without running the body", async () => {
		const user = await account("u2");
		currentSessionUser.mockResolvedValue(user);
		const body = vi.fn().mockResolvedValue(undefined);

		expect(await panelAction("agents:delete", body)).toEqual({ error: REFUSAL_MESSAGE });

		expect(body).not.toHaveBeenCalled();
	});

	it("records the refusal, so probing is visible", async () => {
		const user = await account("u3");
		currentSessionUser.mockResolvedValue(user);

		await panelAction("agents:delete", async () => undefined);

		const row = await lastEvent();
		expect(row.outcome).toBe("DENIED");
		expect(JSON.parse(row.detail as string)).toMatchObject({ permission: "agents:delete" });
	});

	it("lets a superuser through without a single grant row", async () => {
		const user = await account("u4", true);
		currentSessionUser.mockResolvedValue(user);
		const body = vi.fn().mockResolvedValue(undefined);

		expect(await panelAction("agents:delete", body)).toEqual({ error: null });

		expect(body).toHaveBeenCalled();
		// A superuser's actions are the ones most worth having in the record, so they are audited
		// identically rather than exempted along with the check.
		expect((await lastEvent()).outcome).toBe("SUCCESS");
	});

	it("passes an ApiError's message through and records a FAILURE", async () => {
		const user = await account("u5", true);
		currentSessionUser.mockResolvedValue(user);

		const state = await panelAction("agents:delete", async () => {
			throw new ApiError("missing_field", "A name is required.");
		});

		expect(state).toEqual({ error: "A name is required." });
		const row = await lastEvent();
		expect(row.outcome).toBe("FAILURE");
		expect(JSON.parse(row.detail as string)).toMatchObject({ error: "A name is required." });
	});

	it("reports an unexpected throw generically and still records it", async () => {
		const user = await account("u6", true);
		currentSessionUser.mockResolvedValue(user);

		const state = await panelAction("agents:delete", async () => {
			throw new Error("socket hung up");
		});

		// An internal message in the panel is at best noise and at worst a disclosure. The record
		// keeps the real one.
		expect(state.error).toBe("Something went wrong. Check the server log.");
		expect(JSON.parse((await lastEvent()).detail as string)).toMatchObject({ error: "socket hung up" });
	});

	it("revalidates only after the body succeeded", async () => {
		const user = await account("u7", true);
		currentSessionUser.mockResolvedValue(user);
		const revalidate = vi.fn();

		await panelAction(
			"agents:delete",
			async () => {
				throw new Error("nope");
			},
			{ revalidate },
		);

		expect(revalidate).not.toHaveBeenCalled();
	});

	it("records the target so a deleted thing is still named", async () => {
		const user = await account("u8", true);
		currentSessionUser.mockResolvedValue(user);

		await panelAction("agents:delete", async () => undefined, {
			target: { kind: "agent", id: "agent-1", label: "helsinki" },
		});

		const row = await lastEvent();
		expect(row.targetKind).toBe("agent");
		expect(row.targetLabel).toBe("helsinki");
	});
});

describe("panelQuery", () => {
	beforeEach(reset);

	it("returns the body's own shape when permitted", async () => {
		const user = await account("q1", true);
		currentSessionUser.mockResolvedValue(user);

		const result = await panelQuery<Preview>("variables:preview", async () => ({ text: "12:00", error: null }), {
			refused: () => ({ text: null, error: REFUSAL_MESSAGE }),
			failed: () => ({ text: null, error: "broken" }),
		});

		expect(result).toEqual({ text: "12:00", error: null });
	});

	it("writes no row for a successful read", async () => {
		const user = await account("q2", true);
		currentSessionUser.mockResolvedValue(user);

		await panelQuery<Preview>("variables:preview", async () => ({ text: "12:00", error: null }), {
			refused: () => ({ text: null, error: REFUSAL_MESSAGE }),
			failed: () => ({ text: null, error: "broken" }),
		});

		// `previewMoment` runs as an operator types. A row per keystroke would bury the rows worth
		// reading; see the registry's `query` kind.
		expect(await auditDb.auditEvent.count()).toBe(0);
	});

	it("writes a row when a read is refused", async () => {
		const user = await account("q3");
		currentSessionUser.mockResolvedValue(user);

		const result = await panelQuery<Preview>("variables:preview", async () => ({ text: "12:00", error: null }), {
			refused: () => ({ text: null, error: REFUSAL_MESSAGE }),
			failed: () => ({ text: null, error: "broken" }),
		});

		expect(result).toEqual({ text: null, error: REFUSAL_MESSAGE });
		expect((await lastEvent()).outcome).toBe("DENIED");
	});

	it("still records success for a command that merely shapes its own result", async () => {
		const user = await account("q4", true);
		currentSessionUser.mockResolvedValue(user);

		// `keys:create` goes through panelQuery because it returns a one-time secret, and is a
		// `command` because minting a key is exactly the thing the record exists to hold. The wrapper
		// and the audit policy are separate decisions.
		await panelQuery<Minted>("keys:create", async () => ({ error: null, secret: "k" }), {
			refused: () => ({ error: REFUSAL_MESSAGE, secret: null }),
			failed: () => ({ error: "broken", secret: null }),
		});

		expect((await lastEvent()).outcome).toBe("SUCCESS");
	});

	it("records a failed read and hands back the caller's shape", async () => {
		const user = await account("q5", true);
		currentSessionUser.mockResolvedValue(user);

		const result = await panelQuery<Preview>(
			"variables:preview",
			async () => {
				throw new Error("clock exploded");
			},
			{
				refused: () => ({ text: null, error: REFUSAL_MESSAGE }),
				failed: () => ({ text: null, error: "broken" }),
			},
		);

		expect(result).toEqual({ text: null, error: "broken" });
		expect((await lastEvent()).outcome).toBe("FAILURE");
	});
});

describe("panelSelf", () => {
	beforeEach(reset);

	it("hands back the session for an ungated action", async () => {
		const user = await account("s1");
		currentSessionUser.mockResolvedValue(user);

		expect((await panelSelf("self:change-password")).id).toBe("s1");
	});

	it("refuses to be used for a gated one", async () => {
		const user = await account("s2", true);
		currentSessionUser.mockResolvedValue(user);

		// Calling this on a gated action would skip the permission check entirely, so it is a
		// mistake worth failing loudly rather than one worth tolerating.
		await expect(panelSelf("agents:delete")).rejects.toThrow(/gated/);
	});
});

/**
 * The gate's second question: not "may you run this action" but "may you run it against *that*
 * account". Holding `users:set-password` for helpdesk duty must not be a way to replace the
 * superuser's password and then sign in as it, which is every permission at once.
 *
 * Written against the gate rather than against the five exploitable `users:*` actions on purpose.
 * The property worth holding is "any action carrying a user target", including the ones not written
 * yet, and a per-action test would go green while the next action added stayed open.
 */
describe("the protected-target guard", () => {
	beforeEach(reset);

	/** An action the caller is fully permitted to run, aimed at `targetId`. */
	async function aimAt(targetId: string) {
		const body = vi.fn().mockResolvedValue(undefined);
		const state = await panelAction("users:set-password", body, {
			target: { kind: "user", id: targetId },
		});
		return { body, state };
	}

	it("refuses a permitted non-superuser aiming at a superuser, without running the body", async () => {
		const user = await account("guard-operator");
		await prisma.userPermission.create({ data: { userId: user.id, permission: "users:set-password" } });
		await account("guard-owner", true);
		currentSessionUser.mockResolvedValue(user);

		const { body, state } = await aimAt("guard-owner");

		expect(state).toEqual({ error: REFUSAL_MESSAGE });
		expect(body).not.toHaveBeenCalled();
	});

	it("records the refusal as a target refusal, distinguishable from a missing permission", async () => {
		const user = await account("guard-recorded");
		await prisma.userPermission.create({ data: { userId: user.id, permission: "users:set-password" } });
		await account("guard-owner2", true);
		currentSessionUser.mockResolvedValue(user);

		await aimAt("guard-owner2");

		const row = await lastEvent();
		expect(row.outcome).toBe("DENIED");
		// Probing a superuser's account is as visible in the record as any other refusal, and an
		// investigator can tell the two kinds apart.
		expect(JSON.parse(row.detail as string)).toMatchObject({ reason: "protected-target" });
	});

	it("lets a superuser act on another superuser, which is how demotion happens", async () => {
		const user = await account("guard-super", true);
		await account("guard-peer", true);
		currentSessionUser.mockResolvedValue(user);

		const { body, state } = await aimAt("guard-peer");

		expect(state).toEqual({ error: null });
		expect(body).toHaveBeenCalled();
	});

	it("lets an ordinary target through untouched", async () => {
		const user = await account("guard-helpdesk");
		await prisma.userPermission.create({ data: { userId: user.id, permission: "users:set-password" } });
		await account("guard-ordinary");
		currentSessionUser.mockResolvedValue(user);

		const { body, state } = await aimAt("guard-ordinary");

		expect(state).toEqual({ error: null });
		expect(body).toHaveBeenCalled();
	});

	/**
	 * An unknown id is reported by the action's own body, not here. Refusing at the gate would answer
	 * "does this account exist" on a different code path, and with different timing, than every other
	 * id a caller could name.
	 */
	it("does not treat an unknown account as protected", async () => {
		const user = await account("guard-unknown-caller");
		await prisma.userPermission.create({ data: { userId: user.id, permission: "users:set-password" } });
		currentSessionUser.mockResolvedValue(user);

		const { body } = await aimAt("no-such-account");

		expect(body).toHaveBeenCalled();
	});

	/**
	 * A superuser reaching its own account through the Users tab is the ordinary case, and the guard
	 * has to leave it alone — otherwise the last superuser could not change its own password from the
	 * page that offers the field.
	 */
	it("leaves a caller acting on their own account alone", async () => {
		const user = await account("guard-self", true);
		currentSessionUser.mockResolvedValue(user);

		const { body, state } = await aimAt("guard-self");

		expect(state).toEqual({ error: null });
		expect(body).toHaveBeenCalled();
	});

	it("covers a read too, so listing a superuser's sessions is refused the same way", async () => {
		const user = await account("guard-reader");
		await prisma.userPermission.create({ data: { userId: user.id, permission: "users:list-sessions" } });
		await account("guard-owner3", true);
		currentSessionUser.mockResolvedValue(user);

		const result = await panelQuery<string[]>("users:list-sessions", async () => ["a-session"], {
			refused: () => [],
			failed: () => [],
			target: { kind: "user", id: "guard-owner3" },
		});

		expect(result).toEqual([]);
		expect((await lastEvent()).outcome).toBe("DENIED");
	});
});

/**
 * `gate` passes `requireSession` a `skipEnrolmentGate` flag that is true for exactly the two
 * actions enrolling a second factor happens through, and false for everything else — including
 * `self:end-2fa`, a `self`-kind action of its own, so the flag is tied to specific ids and not to
 * the registry's `kind`. Nothing else in the suite observes this: `currentSessionUser` used to be a
 * zero-argument mock, so a caller could widen or delete the bypass entirely and every other test
 * here would stay green.
 */
describe("the enrolment gate bypass", () => {
	beforeEach(reset);

	it("skips the enrolment gate for the action that starts enrolment", async () => {
		const user = await account("bypass1");
		currentSessionUser.mockResolvedValue(user);

		await panelQuery("self:begin-2fa", async () => "ok", {
			refused: () => "refused",
			failed: () => "failed",
		});

		expect(currentSessionUser).toHaveBeenCalledWith({ skipEnrolmentGate: true });
	});

	it("skips the enrolment gate for the action that confirms it", async () => {
		const user = await account("bypass2");
		currentSessionUser.mockResolvedValue(user);

		await panelAction("self:confirm-2fa", async () => undefined);

		expect(currentSessionUser).toHaveBeenCalledWith({ skipEnrolmentGate: true });
	});

	it("does not skip it for turning a second factor off", async () => {
		const user = await account("bypass3");
		currentSessionUser.mockResolvedValue(user);

		// `self:end-2fa` is `self`-kind too, the same as the two above — proving the flag follows the
		// id, not the kind, is the whole point of this case.
		await panelAction("self:end-2fa", async () => undefined);

		expect(currentSessionUser).toHaveBeenCalledWith({ skipEnrolmentGate: false });
	});

	it("does not skip it for an unrelated gated action", async () => {
		const user = await account("bypass4");
		currentSessionUser.mockResolvedValue(user);

		await panelAction("agents:delete", async () => undefined);

		expect(currentSessionUser).toHaveBeenCalledWith({ skipEnrolmentGate: false });
	});
});
