import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Logs tab's one action: `listMoreLogs`, behind its infinite scroll.
 *
 * `permission-matrix.test.ts` already proves the gate itself is consulted for every `command` and
 * `query` in the registry; what is left here is that this particular query re-checks `logs:read`
 * against the *actual* effective-permissions path (this file does not stub `require-permission`), that
 * it narrows exactly as `listLogs` would from the page's own `searchParams`, and that a hostile offset
 * cannot reach `listLogs` unclamped.
 */
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/request-context", () => ({
	getClientAddress: async () => "203.0.113.50",
	getUserAgent: async () => "vitest",
}));

const currentSessionUser = vi.fn();
vi.mock("@/lib/auth/require-session", () => ({
	requireSession: async () => currentSessionUser(),
	currentSessionId: async (fallback: string) => fallback,
}));

const { listMoreLogs } = await import("@/app/(panel)/logs/actions");
const { auditDb, logsDb, prisma } = await import("@/lib/db");

let nextAccount = 0;

/** A fresh account, with an id no earlier case has used — `effectivePermissions` memoises per id. */
async function account(permissions: string[], isSuperuser = false) {
	nextAccount += 1;
	const id = `logs-action-${nextAccount}`;
	await prisma.user.create({ data: { id, name: id, email: `${id}@example.com`, isSuperuser } });
	for (const permission of permissions) {
		await prisma.userPermission.create({ data: { userId: id, permission } });
	}
	const user = { id, name: id, email: `${id}@example.com`, isSuperuser, mustChangePassword: false };
	currentSessionUser.mockResolvedValue(user);
	return user;
}

beforeEach(async () => {
	await auditDb.auditEvent.deleteMany({});
	await logsDb.logEntry.deleteMany({});
	await prisma.userPermission.deleteMany({});
	await prisma.session.deleteMany({});
	await prisma.account.deleteMany({});
	await prisma.user.deleteMany({});
	currentSessionUser.mockReset();
});

describe("listMoreLogs", () => {
	it("refuses a caller without logs:read, and records the refusal", async () => {
		await account([]);

		const batch = await listMoreLogs({ offset: 0 });

		expect(batch.lines).toEqual([]);
		expect(batch.more).toBe(false);
		expect(batch.error).toContain("permission");
		const row = await auditDb.auditEvent.findFirstOrThrow({ orderBy: { seq: "desc" } });
		expect(row.action).toBe("logs:list-more");
		expect(row.outcome).toBe("DENIED");
	});

	it("returns the batch starting at the given offset", async () => {
		await account(["logs:read"]);
		await logsDb.logEntry.createMany({
			data: Array.from({ length: 3 }, (_, index) => ({
				level: "INFO" as const,
				severity: 1,
				message: `line ${index}`,
			})),
		});

		const first = await listMoreLogs({ offset: 0 });
		expect(first.lines).toHaveLength(3);
		expect(first.more).toBe(false);

		const second = await listMoreLogs({ offset: first.lines.length });
		expect(second.lines).toEqual([]);
	});

	it("narrows to the levels the dropdown would send, dropping DEBUG", async () => {
		await account(["logs:read"]);
		await logsDb.logEntry.createMany({
			data: [
				{ level: "DEBUG", severity: 0, message: "debug line" },
				{ level: "WARN", severity: 2, message: "warn line" },
				{ level: "ERROR", severity: 3, message: "error line" },
			],
		});

		// The tab's dropdown is multi-select and sends several values in one comma-joined parameter;
		// DEBUG is not one it has ever offered, so it must not be reachable through this action either.
		const batch = await listMoreLogs({ offset: 0, level: "WARN,ERROR,DEBUG" });

		expect(batch.lines.map((line) => line.level).sort()).toEqual(["ERROR", "WARN"]);
	});

	it("clamps a hostile offset rather than handing it to the database unclamped", async () => {
		await account(["logs:read"]);
		await logsDb.logEntry.createMany({
			data: Array.from({ length: 2 }, (_, index) => ({
				level: "INFO" as const,
				severity: 1,
				message: `line ${index}`,
			})),
		});

		const batch = await listMoreLogs({ offset: Number.NaN });

		expect(batch.error).toBeNull();
		expect(batch.lines).toHaveLength(2);
	});

	it("does not record a success, so a scroll leaves no trail in a tab that records nothing else", async () => {
		await account(["logs:read"]);

		await listMoreLogs({ offset: 0 });

		expect(await auditDb.auditEvent.count()).toBe(0);
	});
});
