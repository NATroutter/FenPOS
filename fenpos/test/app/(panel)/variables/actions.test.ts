import { beforeEach, describe, expect, it, vi } from "vitest";

const SESSION_USER = {
	id: "test-user",
	name: "Test User",
	email: "test@example.com",
	isSuperuser: true,
	mustChangePassword: false,
};
vi.mock("@/lib/auth/require-session", () => ({
	requireSession: vi.fn(async () => SESSION_USER),
	currentUser: vi.fn(async () => SESSION_USER),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { removeVariable, saveVariable } = await import("@/app/(panel)/variables/actions");
const { prisma } = await import("@/lib/db");
const { listVariables } = await import("@/lib/variables/variable-service");

const input = (over: Record<string, unknown> = {}) => ({
	name: "phone",
	kind: "STATIC" as const,
	value: "010-1234567",
	pattern: null,
	offsetAmount: null,
	offsetUnit: null,
	source: null,
	overridable: false,
	description: null,
	...over,
});

describe("variable actions", () => {
	beforeEach(async () => {
		await prisma.deviceVariable.deleteMany();
		await prisma.variable.deleteMany();
	});

	it("creates a variable when given no id", async () => {
		const state = await saveVariable(null, input());

		expect(state.error).toBeNull();
		expect(await listVariables()).toHaveLength(1);
	});

	it("updates in place when given an id", async () => {
		await saveVariable(null, input());
		const [created] = await listVariables();

		const state = await saveVariable(created.id, input({ value: "020-7654321" }));

		expect(state.error).toBeNull();
		expect((await listVariables())[0].value).toBe("020-7654321");
	});

	it("reports an invalid definition as a message rather than throwing", async () => {
		const state = await saveVariable(null, input({ name: "Not A Slug" }));

		expect(state.error).toBeTruthy();
		expect(await listVariables()).toHaveLength(0);
	});

	it("removes a variable", async () => {
		await saveVariable(null, input());
		const [created] = await listVariables();

		const state = await removeVariable(created.id);

		expect(state.error).toBeNull();
		expect(await listVariables()).toHaveLength(0);
	});
});
