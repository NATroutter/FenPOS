import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Audit tab's two actions.
 *
 * Both are reads, and both are recorded as commands: an export is somebody taking a copy of the
 * record away, which is the single most worth-recording read the system has.
 *
 * The gate itself is proved for these two by `permission-matrix.test.ts`, which walks every entry.
 * What is left here is what the matrix cannot see — that the bodies do the right thing once allowed.
 */
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/request-context", () => ({
	getClientAddress: async () => "203.0.113.50",
	getUserAgent: async () => "vitest",
}));

const currentSessionUser = vi.fn();
vi.mock("@/lib/auth/require-session", () => ({ requireSession: async () => currentSessionUser() }));

const { exportAuditCsv, verifyChain } = await import("@/app/(panel)/audit/actions");
const { appendEvent, SYSTEM_ACTOR } = await import("@/lib/audit/audit-log");
const { prisma } = await import("@/lib/db");

let nextAccount = 0;

/** A superuser with an id no earlier case has used — `effectivePermissions` memoises per id. */
async function superuser() {
	nextAccount += 1;
	const id = `audit-action-${nextAccount}`;
	await prisma.user.create({ data: { id, name: id, email: `${id}@example.com`, isSuperuser: true } });
	const user = { id, name: id, email: `${id}@example.com`, isSuperuser: true, mustChangePassword: false };
	currentSessionUser.mockResolvedValue(user);
	return user;
}

beforeEach(async () => {
	await prisma.auditEvent.deleteMany({});
	await prisma.auditAnchor.deleteMany({});
	await prisma.session.deleteMany({});
	await prisma.account.deleteMany({});
	await prisma.user.deleteMany({});
	currentSessionUser.mockReset();
});

describe("verifyChain", () => {
	it("confirms an untouched chain", async () => {
		await superuser();
		await appendEvent({ action: "test:one", outcome: "SUCCESS", actor: SYSTEM_ACTOR });

		const status = await verifyChain();

		expect(status.ok).toBe(true);
		expect(status.message).toContain("intact");
	});

	it("names the seq where an edited row breaks it", async () => {
		await superuser();
		await appendEvent({ action: "test:one", outcome: "SUCCESS", actor: SYSTEM_ACTOR });
		await appendEvent({ action: "test:two", outcome: "SUCCESS", actor: SYSTEM_ACTOR });
		const first = await prisma.auditEvent.findFirstOrThrow({ orderBy: { seq: "asc" } });
		await prisma.auditEvent.update({ where: { seq: first.seq }, data: { action: "test:edited" } });

		const status = await verifyChain();

		expect(status.ok).toBe(false);
		expect(status.message).toContain(`seq ${first.seq}`);
	});

	it("records that it ran", async () => {
		await superuser();

		await verifyChain();

		const row = await prisma.auditEvent.findFirstOrThrow({ orderBy: { seq: "desc" } });
		expect(row.action).toBe("audit:verify");
		expect(row.outcome).toBe("SUCCESS");
	});
});

describe("exportAuditCsv", () => {
	it("returns the filtered range as CSV", async () => {
		await superuser();
		await appendEvent({ action: "devices:delete", outcome: "SUCCESS", actor: SYSTEM_ACTOR });
		await appendEvent({ action: "keys:create", outcome: "SUCCESS", actor: SYSTEM_ACTOR });

		const result = await exportAuditCsv({ action: "devices:delete" });

		expect(result.error).toBeNull();
		expect(result.csv).toContain("devices:delete");
		expect(result.csv).not.toContain("keys:create");
	});

	it("records what was exported, not the export itself", async () => {
		await superuser();
		await appendEvent({ action: "devices:delete", outcome: "SUCCESS", actor: SYSTEM_ACTOR });

		await exportAuditCsv({ action: "devices:delete" });

		const row = await prisma.auditEvent.findFirstOrThrow({ orderBy: { seq: "desc" } });
		expect(row.action).toBe("audit:export");
		// The filter is in the row; the exported rows are not. A copy of the export inside the record
		// would double the table every time somebody pressed the button.
		expect(row.detail).toContain("devices:delete");
	});

	it("refuses a date it cannot parse rather than exporting everything", async () => {
		await superuser();
		await appendEvent({ action: "devices:delete", outcome: "SUCCESS", actor: SYSTEM_ACTOR });

		const result = await exportAuditCsv({ from: "not-a-date" });

		expect(result.csv).toBeNull();
		expect(result.error).toContain("date");
	});

	it("refuses an outcome that is not one this system uses", async () => {
		await superuser();

		const result = await exportAuditCsv({ outcome: "MAYBE" });

		expect(result.csv).toBeNull();
		expect(result.error).toContain("outcome");
	});
});
