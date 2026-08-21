import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { maxAssetBytes } from "@/lib/assets/asset-service";
import { prisma } from "@/lib/db";

/**
 * Tests for the Assets tab's actions.
 *
 * The property worth pinning here is the upload cap. It is the one limit in this feature that a
 * framework would otherwise decide: Next caps a server action's body at 1 MB by default, and
 * `next.config.ts` raises that ceiling to 16 MB precisely so that `assets.maxUploadKb` — 2 MB by
 * default, and this product's to enforce — is a number this project actually applies rather than
 * one a framework default overrides. If someone deletes the check in the action, nothing in the
 * framework puts it back — the config now says 16 MB — so this is what notices.
 *
 * The session guard is stubbed rather than satisfied: it redirects, and a redirect is not what these
 * tests are about. `revalidatePath` is stubbed because it needs a request scope these do not have.
 */
vi.mock("@/lib/auth/require-session", () => ({
	requireSession: async () => {},
}));
vi.mock("next/cache", () => ({
	revalidatePath: () => {},
}));

/**
 * The agent sync, captured rather than run.
 *
 * Two things are being pinned. The first is that it is *scheduled* rather than awaited: fanning a
 * fresh configuration out to every connected agent is work that grows with how many agents are
 * connected and how many images are stored, and none of it is work the operator who pressed Upload
 * is waiting for. The second is that it happens after everything that can fail the action, so a sync
 * that failed cannot report "something went wrong" for a file that was plainly saved.
 */
const scheduled = vi.hoisted(() => [] as (() => unknown)[]);
const pushConfigToEveryAgent = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("next/server", () => ({
	after: (work: () => unknown) => {
		scheduled.push(work);
	},
}));
vi.mock("@/lib/link/agent-connection", () => ({ pushConfigToEveryAgent }));

const { removeAsset, uploadAsset } = await import("@/app/(panel)/assets/actions");

const PNG = readFileSync("test/fixtures/logo.png");

/**
 * Builds the form the upload action reads.
 *
 * @param name the asset name field
 * @param bytes the file's content
 * @returns the form data
 */
function upload(name: string, bytes: Buffer): FormData {
	const form = new FormData();
	form.set("name", name);
	form.set("file", new File([new Uint8Array(bytes)], "logo.png", { type: "image/png" }));
	return form;
}

beforeEach(async () => {
	await prisma.asset.deleteMany();
	// Not this file's subject, but the cap this test asserts against is now read from a setting
	// rather than a fixed constant, so a stray override left by another suite sharing this
	// worker's database would silently change what "the cap this product enforces" means here.
	await prisma.setting.deleteMany({ where: { key: "assets.maxUploadKb" } });
	scheduled.length = 0;
	pushConfigToEveryAgent.mockClear();
});

describe("uploadAsset", () => {
	it("stores the file", async () => {
		expect(await uploadAsset(upload("logo", PNG))).toEqual({ error: null });

		expect(await prisma.asset.count()).toBe(1);
	});

	it("refuses a file past the cap this product enforces", async () => {
		const result = await uploadAsset(upload("huge", Buffer.alloc((await maxAssetBytes()) + 1)));

		expect(result.error).toMatch(/at most 2 MB/);
		expect(await prisma.asset.count()).toBe(0);
	});

	it("asks for a file when none was chosen", async () => {
		const form = new FormData();
		form.set("name", "logo");

		expect((await uploadAsset(form)).error).toMatch(/choose an image/i);
	});

	it("reports a bad name as a message rather than a fault", async () => {
		// The distinction matters: a refusal the operator can act on must not arrive as the
		// catch-all, which tells them to go and read a server log they cannot reach.
		expect((await uploadAsset(upload("Not A Slug", PNG))).error).not.toMatch(/server log/);
	});

	/**
	 * Every connected agent holds the image library dithered for its own paper, so an upload has to
	 * reach all of them — but not before the operator gets their answer. Asserted as "not called by
	 * the time the action returned, and called when what was scheduled runs", which is the difference
	 * between deferring the work and merely moving the line it sits on.
	 */
	it("schedules the agent sync after the response rather than blocking on it", async () => {
		expect(await uploadAsset(upload("logo", PNG))).toEqual({ error: null });

		expect(pushConfigToEveryAgent).not.toHaveBeenCalled();
		expect(scheduled).toHaveLength(1);

		await scheduled[0]();
		expect(pushConfigToEveryAgent).toHaveBeenCalledTimes(1);
	});

	it("schedules nothing when the upload was refused", async () => {
		await uploadAsset(upload("Not A Slug", PNG));

		expect(scheduled).toHaveLength(0);
	});
});

describe("removeAsset", () => {
	it("deletes and reports success", async () => {
		await uploadAsset(upload("logo", PNG));
		const stored = await prisma.asset.findFirstOrThrow();

		expect(await removeAsset(stored.id)).toEqual({ error: null });

		expect(await prisma.asset.count()).toBe(0);
	});

	it("reports an id that is not there", async () => {
		expect((await removeAsset("nope")).error).toMatch(/no longer exists/);
	});
});
