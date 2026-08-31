import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelUser } from "@/lib/auth/require-session";

/**
 * The Settings tab's own-avatar actions: `setOwnAvatar` and `removeOwnAvatar`.
 *
 * `readAvatarForm`, `setAvatar`, `removeAvatar` and `bakeAvatar`'s crop validation are each tested
 * directly and thoroughly elsewhere (`test/lib/auth/avatar-service.test.ts`,
 * `test/lib/auth/avatar-image.test.ts`). What is checked here is the layer this file adds: that a
 * refusal — a missing file, a bad crop, an oversized upload — comes back as a rendered error rather
 * than a throw, that a success writes the audit row `self:set-avatar` / `self:remove-avatar` name,
 * and — the property this task exists to prove — that the row's detail carries the crop and never
 * the picture.
 *
 * `requireSession` is stubbed rather than satisfied for real, the same convention
 * `test/app/(panel)/users/actions.test.ts` uses: `self:*` actions are ungated, so nothing here is
 * about permissions, only about what each action does once it is let through. `revalidatePath` is
 * stubbed too, since it needs a request scope these tests do not have.
 */
let sessionUser: PanelUser | null = null;
vi.mock("@/lib/auth/require-session", () => ({
	requireSession: async () => {
		if (sessionUser === null) {
			throw new Error("test forgot to sign a user in before calling the action");
		}
		return sessionUser;
	},
	currentUser: async () => sessionUser,
	// No session ever rotates on the path these actions exercise `record()` through, so the audit
	// row's session id is whatever `record()` was already carrying — see `currentSessionId`'s own
	// doc in `panel-action.ts`.
	currentSessionId: async (fallback: string) => fallback,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const { removeOwnAvatar, setOwnAvatar } = await import("@/app/(panel)/settings/actions");
const { AVATAR_MAX_BYTES } = await import("@/lib/auth/avatar-image");
const { readAvatar } = await import("@/lib/auth/avatar-service");
const { auditDb } = await import("@/lib/db");
const { makeUser } = await import("@/test/helpers/accounts");
const { latestAuditAction } = await import("@/test/helpers/audit");
const { pngOf } = await import("@/test/helpers/images");

/** Builds the `FormData` the dialog submits: a file, and the crop as three whole-number fields. */
function form(bytes: Buffer | Uint8Array, crop: { x: number; y: number; size: number }): FormData {
	const data = new FormData();
	data.set("file", new File([new Uint8Array(bytes)], "face.png", { type: "image/png" }));
	data.set("x", String(crop.x));
	data.set("y", String(crop.y));
	data.set("size", String(crop.size));
	return data;
}

beforeEach(() => {
	sessionUser = null;
});

describe("setOwnAvatar", () => {
	it("stores the caller's own avatar and audits it, with the crop and never the bytes", async () => {
		const user = await makeUser();
		sessionUser = user;

		const state = await setOwnAvatar(form(await pngOf(120, 120), { x: 0, y: 0, size: 120 }));

		expect(state.error).toBeNull();
		expect(await readAvatar(user.id)).not.toBeNull();
		expect(await latestAuditAction()).toBe("self:set-avatar");

		const row = await auditDb.auditEvent.findFirst({
			where: { action: "self:set-avatar" },
			orderBy: { seq: "desc" },
		});
		// A precise equality rather than a substring check: a stray extra field — the image bytes
		// among them — fails this the moment it is added, not only when somebody thinks to look.
		expect(JSON.parse(row?.detail ?? "null")).toEqual({ crop: { x: 0, y: 0, size: 120 } });
	});

	it("refuses a crop that runs off the image, stores nothing, and names the edge as the reason", async () => {
		const user = await makeUser();
		sessionUser = user;

		const state = await setOwnAvatar(form(await pngOf(50, 50), { x: 0, y: 0, size: 200 }));

		// Distinguishes this refusal from every other kind below rather than merely asserting
		// `state.error` is truthy — a bare truthiness check cannot tell a bad crop from a missing
		// file.
		expect(state.error).toMatch(/edge of the image/i);
		expect(await readAvatar(user.id)).toBeNull();
	});

	it("refuses a form carrying no file, distinctly from every other refusal here", async () => {
		const user = await makeUser();
		sessionUser = user;

		const data = new FormData();
		data.set("x", "0");
		data.set("y", "0");
		data.set("size", "10");

		const state = await setOwnAvatar(data);

		expect(state.error).toMatch(/choose an image/i);
		expect(await readAvatar(user.id)).toBeNull();
	});

	it("refuses a non-integer crop coordinate", async () => {
		const user = await makeUser();
		sessionUser = user;

		const state = await setOwnAvatar(form(await pngOf(50, 50), { x: 0, y: 0, size: Number.NaN }));

		expect(state.error).toMatch(/whole number/i);
		expect(await readAvatar(user.id)).toBeNull();
	});

	it("refuses a file over the byte cap before ever decoding it", async () => {
		const user = await makeUser();
		sessionUser = user;

		// Garbage bytes, not a real PNG: proves the refusal comes from the declared-size check
		// running *before* the bytes are handed to a decoder, since a decode of this would fail
		// with a different message ("not an image this pipeline can print"), not this one.
		const oversized = Buffer.alloc(AVATAR_MAX_BYTES + 1);
		const state = await setOwnAvatar(form(oversized, { x: 0, y: 0, size: 10 }));

		expect(state.error).toMatch(/at most/i);
		expect(await readAvatar(user.id)).toBeNull();
	});
});

describe("removeOwnAvatar", () => {
	it("removes it and audits it", async () => {
		const user = await makeUser();
		sessionUser = user;
		await setOwnAvatar(form(await pngOf(64, 64), { x: 0, y: 0, size: 64 }));

		const state = await removeOwnAvatar();

		expect(state.error).toBeNull();
		expect(await readAvatar(user.id)).toBeNull();
		expect(await latestAuditAction()).toBe("self:remove-avatar");
	});

	it("refuses removing an avatar that does not exist, distinctly from a success", async () => {
		const user = await makeUser();
		sessionUser = user;

		const state = await removeOwnAvatar();

		expect(state.error).toMatch(/no avatar to remove/i);
	});
});
