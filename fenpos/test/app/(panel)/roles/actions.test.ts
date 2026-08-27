import { beforeEach, describe, expect, it, vi } from "vitest";
import { auditDb, prisma } from "@/lib/db";

/**
 * The Roles tab's actions.
 *
 * `role-service.test.ts` covers the rules. What is checked here is that a refusal arrives as a
 * rendered error rather than a throw, and that the audit row names the role and what it now carries
 * — "who gave that role the ability to write raw bytes" being the question the record exists for.
 */
vi.mock("@/lib/auth/require-session", () => ({
	requireSession: async () => ({
		id: "acting-superuser",
		name: "Acting Superuser",
		email: "acting@example.com",
		isSuperuser: true,
		mustChangePassword: false,
	}),
	currentUser: async () => ({
		id: "acting-superuser",
		name: "Acting Superuser",
		email: "acting@example.com",
		isSuperuser: true,
		mustChangePassword: false,
	}),
	// No session ever rotates in this file's actions, so the audit row's session id is whatever
	// `panel-action.ts`'s `record()` was already carrying — see `currentSessionId`'s own doc.
	currentSessionId: async (fallback: string) => fallback,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const { createRole, deleteRole, updateRole } = await import("@/app/(panel)/roles/actions");

const blank = { name: "Printer minder", description: "", permissions: [], memberIds: [] };

beforeEach(async () => {
	await auditDb.auditEvent.deleteMany({});
	await prisma.userRole.deleteMany({});
	await prisma.rolePermission.deleteMany({});
	await prisma.role.deleteMany({});
	await prisma.session.deleteMany({});
	await prisma.account.deleteMany({});
	await prisma.user.deleteMany({});

	await prisma.user.create({
		data: { id: "acting-superuser", name: "Acting Superuser", email: "acting@example.com", isSuperuser: true },
	});
});

describe("createRole", () => {
	it("creates the role and reports no error", async () => {
		expect(await createRole({ ...blank, permissions: ["devices:read"] })).toEqual({ error: null });
		expect(await prisma.role.count()).toBe(1);
	});

	it("records the name and everything the role now carries", async () => {
		await createRole({ ...blank, permissions: ["devices:read", "tools:raw"] });

		const [row] = await auditDb.auditEvent.findMany({ where: { action: "roles:create" } });
		expect(row.targetLabel).toBe("Printer minder");
		expect(row.detail).toContain("tools:raw");
	});

	it("renders a duplicate name as an error rather than throwing", async () => {
		await createRole(blank);

		expect((await createRole(blank)).error).toMatch(/already exists/i);
	});
});

describe("updateRole", () => {
	it("records what the role carries after the change, not before", async () => {
		await createRole({ ...blank, permissions: ["devices:read"] });
		const role = await prisma.role.findFirstOrThrow();

		await updateRole(role.id, { ...blank, permissions: ["jobs:cancel"] });

		const [row] = await auditDb.auditEvent.findMany({ where: { action: "roles:update" } });
		expect(row.detail).toContain("jobs:cancel");
	});
});

describe("deleteRole", () => {
	it("names the role in the record, so the row survives it", async () => {
		await createRole(blank);
		const role = await prisma.role.findFirstOrThrow();

		await deleteRole(role.id);

		const [row] = await auditDb.auditEvent.findMany({ where: { action: "roles:delete" } });
		expect(row.targetLabel).toBe("Printer minder");
		expect(await prisma.role.count()).toBe(0);
	});
});
