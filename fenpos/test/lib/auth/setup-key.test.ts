import { beforeEach, describe, expect, it } from "vitest";
import { isInstallClaimed, rotateSetupKey, verifySetupKey } from "@/lib/auth/setup-key";
import { prisma } from "@/lib/db";

/**
 * The credential that claims an unconfigured install.
 *
 * The properties worth asserting are the ones that differ from the administrator password this
 * replaces: the plaintext is never stored, the key rotates on every mint rather than persisting,
 * and minting stops entirely the moment a user exists.
 */
describe("setup key", () => {
	beforeEach(async () => {
		await prisma.setupKey.deleteMany({});
		await prisma.user.deleteMany({});
	});

	it("mints a key on an unclaimed install", async () => {
		const key = await rotateSetupKey();
		expect(key).not.toBeNull();
		expect(key).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){4}$/);
	});

	it("never stores the plaintext", async () => {
		const key = await rotateSetupKey();
		const row = await prisma.setupKey.findUnique({ where: { id: 1 } });

		expect(row).not.toBeNull();
		expect(JSON.stringify(row)).not.toContain(key);
	});

	it("replaces the previous key rather than adding one", async () => {
		const first = await rotateSetupKey();
		const second = await rotateSetupKey();

		expect(second).not.toBe(first);
		expect(await prisma.setupKey.count()).toBe(1);
		expect(await verifySetupKey(first as string)).toBe(false);
		expect(await verifySetupKey(second as string)).toBe(true);
	});

	it("verifies the current key", async () => {
		const key = await rotateSetupKey();
		expect(await verifySetupKey(key as string)).toBe(true);
	});

	it("refuses a wrong key", async () => {
		await rotateSetupKey();
		expect(await verifySetupKey("XXXX-XXXX-XXXX-XXXX-XXXX")).toBe(false);
	});

	it("refuses any key when none is stored", async () => {
		expect(await verifySetupKey("XXXX-XXXX-XXXX-XXXX-XXXX")).toBe(false);
	});

	it("refuses to mint once a user exists", async () => {
		await prisma.user.create({
			data: { id: "u1", name: "Owner", email: "owner@example.com", updatedAt: new Date() },
		});

		expect(await rotateSetupKey()).toBeNull();
		expect(await prisma.setupKey.count()).toBe(0);
	});

	it("reports whether the install is claimed", async () => {
		expect(await isInstallClaimed()).toBe(false);

		await prisma.user.create({
			data: { id: "u2", name: "Owner", email: "owner2@example.com", updatedAt: new Date() },
		});

		expect(await isInstallClaimed()).toBe(true);
	});
});
