import { Jimp, JimpMime } from "jimp";
import { describe, expect, it, vi } from "vitest";
import {
	readAvatar,
	readAvatarOriginal,
	recropAvatar,
	removeAvatar,
	setAvatar,
	usersWithAvatars,
} from "@/lib/auth/avatar-service";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/errors";
import { makeUser } from "@/test/helpers/accounts";
import { pngOf } from "@/test/helpers/images";

/**
 * Runs something expected to fail and returns the `ApiError` it raised.
 *
 * @param work the call under test
 * @returns the error, having asserted it is an ApiError
 */
async function refusal(work: () => Promise<unknown>): Promise<ApiError> {
	try {
		await work();
	} catch (thrown) {
		expect(thrown).toBeInstanceOf(ApiError);
		return thrown as ApiError;
	}
	throw new Error("expected a refusal, got a success");
}

describe("setAvatar", () => {
	it("stores the original beside the render, so a re-crop has something to start from", async () => {
		const user = await makeUser();
		const original = await pngOf(200, 200);

		await setAvatar(user.id, original, { x: 0, y: 0, size: 100 });

		const kept = await readAvatarOriginal(user.id);
		expect(kept?.bytes.equals(original)).toBe(true);
		expect(kept?.crop).toEqual({ x: 0, y: 0, size: 100 });
		expect(kept?.width).toBe(200);
		expect((await readAvatar(user.id))?.mimeType).toBe("image/png");
	});

	/**
	 * The render is always PNG and the original is whatever arrived, so the two mime types are
	 * different columns holding different things — and a JPEG upload is the only case where they
	 * disagree. `setAvatar` reads the original's type off `bakeAvatar`'s result rather than measuring
	 * the bytes a second time, so a bake that handed back the render's type under the wrong name
	 * would store "image/png" here and nothing else in the suite would notice.
	 */
	it("records the original's own type, not the render's, for a JPEG upload", async () => {
		const user = await makeUser();
		const jpeg = Buffer.from(await new Jimp({ width: 80, height: 80, color: 0xff0000ff }).getBuffer(JimpMime.jpeg));

		await setAvatar(user.id, jpeg, { x: 0, y: 0, size: 80 });

		expect((await readAvatarOriginal(user.id))?.mimeType).toBe("image/jpeg");
		expect((await readAvatar(user.id))?.mimeType).toBe("image/png");
	});

	it("replaces an existing avatar rather than failing on the key", async () => {
		const user = await makeUser();
		await setAvatar(user.id, await pngOf(100, 100), { x: 0, y: 0, size: 50 });
		await setAvatar(user.id, await pngOf(60, 60), { x: 0, y: 0, size: 60 });

		expect((await readAvatarOriginal(user.id))?.width).toBe(60);
	});

	it("refuses before it writes, leaving the previous avatar untouched", async () => {
		const user = await makeUser();
		await setAvatar(user.id, await pngOf(100, 100), { x: 0, y: 0, size: 50 });

		const beforeRender = await readAvatar(user.id);
		const beforeOriginal = await readAvatarOriginal(user.id);

		// A crop that runs off the edge of this smaller image: bakeAvatar must refuse it before
		// setAvatar writes anything, so the account's existing avatar survives unchanged.
		const tooSmall = await pngOf(30, 30);
		const refused = await refusal(() => setAvatar(user.id, tooSmall, { x: 0, y: 0, size: 50 }));
		expect(refused.code).toBe("invalid_type");

		const afterRender = await readAvatar(user.id);
		const afterOriginal = await readAvatarOriginal(user.id);
		expect(afterRender?.bytes.equals(beforeRender?.bytes as Buffer)).toBe(true);
		expect(afterOriginal?.bytes.equals(beforeOriginal?.bytes as Buffer)).toBe(true);
		expect(afterOriginal?.crop).toEqual(beforeOriginal?.crop);
	});
});

describe("recropAvatar", () => {
	it("re-bakes from the original, not from the previous render", async () => {
		const user = await makeUser();

		// A solid-color source (pngOf) resizes to the same bytes for every crop, so it cannot tell
		// this test's two crops apart. A red 50x50 corner on an otherwise blue 400x400 canvas can:
		// the narrow crop below sees only red, the wide crop below sees mostly blue.
		const source = new Jimp({ width: 400, height: 400, color: 0x0000ffff });
		for (let x = 0; x < 50; x++) {
			for (let y = 0; y < 50; y++) {
				source.setPixelColor(0xff0000ff, x, y);
			}
		}
		const original = Buffer.from(await source.getBuffer(JimpMime.png));

		await setAvatar(user.id, original, { x: 0, y: 0, size: 50 });
		const narrow = await readAvatar(user.id);

		// Widening past the first crop can only work if the original was kept: the previous render
		// is 512px of what was inside a 50px box, with no pixels beyond it to recover.
		await recropAvatar(user.id, { x: 0, y: 0, size: 400 });

		const wide = await readAvatar(user.id);
		expect(wide?.bytes.equals(narrow?.bytes as Buffer)).toBe(false);
		expect((await readAvatarOriginal(user.id))?.crop.size).toBe(400);
	});

	it("refuses when the account has no avatar", async () => {
		const user = await makeUser();
		const refused = await refusal(() => recropAvatar(user.id, { x: 0, y: 0, size: 10 }));

		expect(refused.code).toBe("unknown_avatar");
	});
});

describe("removeAvatar", () => {
	it("takes the row away", async () => {
		const user = await makeUser();
		await setAvatar(user.id, await pngOf(80, 80), { x: 0, y: 0, size: 80 });

		await removeAvatar(user.id);

		expect(await readAvatar(user.id)).toBeNull();
	});

	it("refuses when there is nothing to remove", async () => {
		const user = await makeUser();
		const refused = await refusal(() => removeAvatar(user.id));

		expect(refused.code).toBe("unknown_avatar");
	});
});

describe("usersWithAvatars", () => {
	it("names only those that have one", async () => {
		const withOne = await makeUser();
		const without = await makeUser();
		await setAvatar(withOne.id, await pngOf(40, 40), { x: 0, y: 0, size: 40 });

		const found = await usersWithAvatars([withOne.id, without.id]);

		expect(found.has(withOne.id)).toBe(true);
		expect(found.has(without.id)).toBe(false);
	});

	it("asks the database nothing when given no ids", async () => {
		// The size assertion alone cannot tell "no query happened" from "an empty query happened" —
		// both return zero rows. The spy is what the title actually promises.
		const findMany = vi.spyOn(prisma.avatar, "findMany");
		try {
			expect((await usersWithAvatars([])).size).toBe(0);
			expect(findMany).not.toHaveBeenCalled();
		} finally {
			findMany.mockRestore();
		}
	});
});
