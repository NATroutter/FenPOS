import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Users tab's avatar actions: `setUserAvatar` and `removeUserAvatar`.
 *
 * Unlike Task 8's `self:*` pair, these are gated. Setting somebody *else's* avatar is not on the
 * spec's "not gated, deliberately" list, so this pair gets the same care as every other `users:*`
 * action beside it: a real permission check, a `DENIED` row when refused, and the crop — never the
 * picture — recorded in `detail` alongside the account it was set on.
 *
 * `setAvatar`/`removeAvatar`/`readAvatarForm` and `bakeAvatar`'s crop validation are each tested
 * directly and thoroughly elsewhere (`test/lib/auth/avatar-service.test.ts`,
 * `test/lib/auth/avatar-image.test.ts`). What is checked here is the layer this file adds: that the
 * permission is actually consulted (the general case is `permission-matrix.test.ts`'s job; this is
 * the one place that exercises the *real* bodies rather than a spy), that a refusal renders rather
 * than throws, and — the case a swapped argument would sail through — that the avatar lands on the
 * *target* account, never the actor's own.
 *
 * `requireSession` is stubbed with a `vi.fn()`, the same convention `permission-matrix.test.ts` uses,
 * because each case needs a different acting account: a granted holder, an ungranted one, and (via
 * `panelAction`'s own bypass, already proven by that suite) implicitly a superuser. `revalidatePath`
 * is stubbed too, since it needs a request scope these tests do not have.
 */
const currentSessionUser = vi.fn();
vi.mock("@/lib/auth/require-session", () => ({
	requireSession: async () => currentSessionUser(),
	// No session ever rotates on the path these actions exercise `record()` through, so the audit
	// row's session id is whatever `record()` was already carrying — see `currentSessionId`'s own
	// doc in `panel-action.ts`.
	currentSessionId: async (fallback: string) => fallback,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const { removeUserAvatar, setUserAvatar } = await import("@/app/(panel)/users/actions");
const { readAvatar } = await import("@/lib/auth/avatar-service");
const { auditDb, prisma } = await import("@/lib/db");
const { makeUser, makeUserWith } = await import("@/test/helpers/accounts");
const { latestAuditAction, latestAuditOutcome } = await import("@/test/helpers/audit");
const { pngOf } = await import("@/test/helpers/images");

/** Builds the `FormData` the dialog submits: a file, and the crop as three whole-number fields. */
function form(bytes: Buffer | Uint8Array): FormData {
	const data = new FormData();
	data.set("file", new File([new Uint8Array(bytes)], "face.png", { type: "image/png" }));
	data.set("x", "0");
	data.set("y", "0");
	data.set("size", "60");
	return data;
}

beforeEach(async () => {
	await auditDb.auditEvent.deleteMany({});
	await prisma.userPermission.deleteMany({});
	await prisma.userRole.deleteMany({});
	await prisma.rolePermission.deleteMany({});
	await prisma.role.deleteMany({});
	await prisma.session.deleteMany({});
	await prisma.account.deleteMany({});
	await prisma.avatar.deleteMany({});
	await prisma.user.deleteMany({});
	currentSessionUser.mockReset();
});

describe("setUserAvatar", () => {
	it("lets a holder of users:update set someone else's", async () => {
		const admin = await makeUserWith(["users:update"]);
		const target = await makeUser();
		currentSessionUser.mockResolvedValue(admin);

		const state = await setUserAvatar(target.id, form(await pngOf(60, 60)));

		expect(state.error).toBeNull();
		expect(await readAvatar(target.id)).not.toBeNull();
		expect(await latestAuditAction()).toBe("users:set-avatar");
	});

	it("refuses without the grant, and writes a DENIED row", async () => {
		const nobody = await makeUserWith([]);
		const target = await makeUser();
		currentSessionUser.mockResolvedValue(nobody);

		const state = await setUserAvatar(target.id, form(await pngOf(60, 60)));

		expect(state.error).toBeDefined();
		expect(await readAvatar(target.id)).toBeNull();
		expect(await latestAuditOutcome()).toBe("DENIED");
	});

	// The trap the brief calls out by name: a `userId` argument threaded to `user.id` by mistake
	// would pass both cases above (the actor is the one doing the setting either way) and only show
	// up here, where the actor and the target are two different accounts.
	it("writes the avatar against the target's id, not the actor's", async () => {
		const admin = await makeUserWith(["users:update"]);
		const target = await makeUser();
		currentSessionUser.mockResolvedValue(admin);

		await setUserAvatar(target.id, form(await pngOf(60, 60)));

		expect(await readAvatar(target.id)).not.toBeNull();
		expect(await readAvatar(admin.id)).toBeNull();
	});

	it("records the target account and the crop, and never the picture", async () => {
		const admin = await makeUserWith(["users:update"]);
		const target = await makeUser();
		currentSessionUser.mockResolvedValue(admin);

		await setUserAvatar(target.id, form(await pngOf(60, 60)));

		const row = await auditDb.auditEvent.findFirstOrThrow({
			where: { action: "users:set-avatar" },
			orderBy: { seq: "desc" },
		});
		expect(JSON.parse(row.detail ?? "null")).toEqual({ userId: target.id, crop: { x: 0, y: 0, size: 60 } });
	});
});

describe("removeUserAvatar", () => {
	it("removes someone else's with the grant", async () => {
		const admin = await makeUserWith(["users:update"]);
		const target = await makeUser();
		currentSessionUser.mockResolvedValue(admin);
		await setUserAvatar(target.id, form(await pngOf(60, 60)));

		const state = await removeUserAvatar(target.id);

		expect(state.error).toBeNull();
		expect(await readAvatar(target.id)).toBeNull();
		expect(await latestAuditAction()).toBe("users:remove-avatar");
	});

	it("refuses without the grant, and writes a DENIED row", async () => {
		const admin = await makeUserWith(["users:update"]);
		const target = await makeUser();
		currentSessionUser.mockResolvedValue(admin);
		await setUserAvatar(target.id, form(await pngOf(60, 60)));

		const nobody = await makeUserWith([]);
		currentSessionUser.mockResolvedValue(nobody);

		const state = await removeUserAvatar(target.id);

		expect(state.error).toBeDefined();
		expect(await readAvatar(target.id)).not.toBeNull();
		expect(await latestAuditOutcome()).toBe("DENIED");
	});
});
