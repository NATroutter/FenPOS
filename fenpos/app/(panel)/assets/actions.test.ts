import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_ASSET_BYTES } from "@/lib/assets/asset-service";
import { prisma } from "@/lib/db";

/**
 * Tests for the Assets tab's actions.
 *
 * The property worth pinning here is the upload cap. It is the one limit in this feature that a
 * framework would otherwise decide: Next caps a server action's body at 1 MB by default, and
 * `next.config.ts` raises that ceiling to 4 MB precisely so that the 2 MB this product enforces is
 * a number written in this repository. If someone deletes the check in the action, nothing in the
 * framework puts it back — the config now says 4 MB — so this is what notices.
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
});

describe("uploadAsset", () => {
	it("stores the file", async () => {
		expect(await uploadAsset(upload("logo", PNG))).toEqual({ error: null });

		expect(await prisma.asset.count()).toBe(1);
	});

	it("refuses a file past the cap this product enforces", async () => {
		const result = await uploadAsset(upload("huge", Buffer.alloc(MAX_ASSET_BYTES + 1)));

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
