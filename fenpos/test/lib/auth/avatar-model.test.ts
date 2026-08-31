import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { makeUser } from "@/test/helpers/accounts";

describe("the avatar table", () => {
	it("holds one row per user, keyed by the user", async () => {
		const user = await makeUser();
		await prisma.avatar.create({
			data: {
				userId: user.id,
				original: Buffer.from([1, 2, 3]),
				originalMimeType: "image/png",
				cropX: 0,
				cropY: 0,
				cropSize: 100,
				baked: Buffer.from([4, 5, 6]),
				bakedMimeType: "image/png",
				bakedSize: 512,
			},
		});

		await expect(
			prisma.avatar.create({
				data: {
					userId: user.id,
					original: Buffer.from([7]),
					originalMimeType: "image/png",
					cropX: 0,
					cropY: 0,
					cropSize: 100,
					baked: Buffer.from([8]),
					bakedMimeType: "image/png",
					bakedSize: 512,
				},
			}),
		).rejects.toThrow();
	});

	it("goes when the user goes, so deleting an account leaves no orphan bytes", async () => {
		const user = await makeUser();
		await prisma.avatar.create({
			data: {
				userId: user.id,
				original: Buffer.from([1]),
				originalMimeType: "image/png",
				cropX: 0,
				cropY: 0,
				cropSize: 10,
				baked: Buffer.from([2]),
				bakedMimeType: "image/png",
				bakedSize: 512,
			},
		});

		await prisma.user.delete({ where: { id: user.id } });

		expect(await prisma.avatar.findUnique({ where: { userId: user.id } })).toBeNull();
	});
});
