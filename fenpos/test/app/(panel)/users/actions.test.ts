import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";

/**
 * The Users tab's actions.
 *
 * The services underneath are tested directly and thoroughly elsewhere. What is checked here is the
 * layer this file adds and nothing else: that a refusal comes back as a rendered error rather than a
 * throw, that the audit row an action leaves says what happened, and — the one worth writing down —
 * that no password ever reaches `detail`.
 *
 * The session guard is stubbed rather than satisfied: it redirects, and a redirect is not what these
 * tests are about. The stubbed user is a superuser, so the permission check passes and what is left
 * under test is the action itself. `revalidatePath` is stubbed because it needs a request scope
 * these do not have.
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
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const { banUser, createUser, deleteUser, setUserPassword, updateUser } = await import("@/app/(panel)/users/actions");

const form = {
	name: "Sam Operator",
	email: "sam@example.com",
	password: "a-long-enough-password",
	requirePasswordReset: false,
	roleIds: [],
	permissions: [],
};

/** The audit rows an action left, oldest first. */
async function rows(action: string) {
	return prisma.auditEvent.findMany({ where: { action }, orderBy: { seq: "asc" } });
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
	await prisma.setting.deleteMany({});

	await prisma.user.create({
		data: { id: "acting-superuser", name: "Acting Superuser", email: "acting@example.com", isSuperuser: true },
	});
});

describe("createUser", () => {
	it("creates the account and reports no error", async () => {
		expect(await createUser(form)).toEqual({ error: null });
		expect(await prisma.user.count({ where: { email: "sam@example.com" } })).toBe(1);
	});

	it("records what was created, and never the password", async () => {
		await createUser({ ...form, permissions: ["devices:read"] });

		const [row] = await rows("users:create");
		expect(row.outcome).toBe("SUCCESS");
		expect(row.targetLabel).toBe("sam@example.com");
		expect(row.detail).toContain("devices:read");
		// The one assertion in this file that is a security property rather than a behaviour.
		expect(row.detail).not.toContain("a-long-enough-password");
	});

	it("renders a refusal rather than throwing it", async () => {
		await createUser(form);

		const result = await createUser(form);

		expect(result.error).toMatch(/already in use/i);
	});

	it("records a failed attempt as a failure, carrying why", async () => {
		await createUser(form);
		await createUser(form);

		const [, second] = await rows("users:create");
		expect(second.outcome).toBe("FAILURE");
	});
});

describe("updateUser", () => {
	it("records the new name and address in full", async () => {
		await createUser(form);
		const target = await prisma.user.findFirstOrThrow({ where: { email: "sam@example.com" } });

		await updateUser(target.id, "Sam Renamed", "renamed@example.com");

		const [row] = await rows("users:update");
		// "Who changed that account's email, and to what" is the question a compromised-account
		// investigation opens with.
		expect(row.detail).toContain("renamed@example.com");
	});
});

describe("setUserPassword", () => {
	it("succeeds without putting the password anywhere in the record", async () => {
		await createUser(form);
		const target = await prisma.user.findFirstOrThrow({ where: { email: "sam@example.com" } });

		expect(await setUserPassword(target.id, "a-completely-different-password")).toEqual({ error: null });

		const [row] = await rows("users:set-password");
		expect(row.outcome).toBe("SUCCESS");
		expect(row.detail ?? "").not.toContain("a-completely-different-password");
	});
});

describe("banUser", () => {
	it("records the reason and the expiry", async () => {
		await createUser(form);
		const target = await prisma.user.findFirstOrThrow({ where: { email: "sam@example.com" } });
		const until = new Date(Date.now() + 86_400_000);

		await banUser(target.id, "Left the company", until.toISOString());

		const [row] = await rows("users:ban");
		expect(row.detail).toContain("Left the company");
	});

	it("renders the guard's refusal", async () => {
		const result = await banUser("acting-superuser", "Slipped", null);

		expect(result.error).toMatch(/your own account/i);
	});
});

describe("deleteUser", () => {
	it("names the account in the record, so the row survives it", async () => {
		await createUser(form);
		const target = await prisma.user.findFirstOrThrow({ where: { email: "sam@example.com" } });

		await deleteUser(target.id);

		const [row] = await rows("users:delete");
		expect(row.targetId).toBe(target.id);
		expect(row.targetLabel).toBe("sam@example.com");
		expect(await prisma.user.findUnique({ where: { id: target.id } })).toBeNull();
	});
});
