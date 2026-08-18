import { beforeEach, describe, expect, it } from "vitest";
import { isAdminConfigured, setAdminPassword, verifyAdminPassword } from "@/lib/auth/admin";
import { createSession, resolveSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";

describe("administrator credential", () => {
	beforeEach(async () => {
		await prisma.session.deleteMany({});
		await prisma.adminAuth.deleteMany({});
	});

	it("reports an unconfigured install", async () => {
		await expect(isAdminConfigured()).resolves.toBe(false);
	});

	it("reports a configured install once bootstrapped", async () => {
		await setAdminPassword("correct horse battery staple");
		await expect(isAdminConfigured()).resolves.toBe(true);
	});

	it("verifies the password it was set to", async () => {
		await setAdminPassword("correct horse battery staple");
		await expect(verifyAdminPassword("correct horse battery staple")).resolves.toBe(true);
	});

	it("rejects the wrong password", async () => {
		await setAdminPassword("correct horse battery staple");
		await expect(verifyAdminPassword("incorrect horse battery staple")).resolves.toBe(false);
	});

	it("rejects any password when no administrator is configured", async () => {
		await expect(verifyAdminPassword("anything at all")).resolves.toBe(false);
	});

	it("stores a hash rather than the password", async () => {
		await setAdminPassword("correct horse battery staple");

		const row = await prisma.adminAuth.findFirst({ select: { passwordHash: true } });
		expect(row?.passwordHash).toMatch(/^\$argon2id\$/);
		expect(row?.passwordHash).not.toContain("correct horse");
	});

	it("remains a singleton across repeated changes", async () => {
		await setAdminPassword("first password here");
		await setAdminPassword("second password here");

		expect(await prisma.adminAuth.count()).toBe(1);
		await expect(verifyAdminPassword("second password here")).resolves.toBe(true);
		await expect(verifyAdminPassword("first password here")).resolves.toBe(false);
	});

	it("ends every session when the password changes", async () => {
		await setAdminPassword("first password here");
		const session = await createSession();
		await expect(resolveSession(session.token)).resolves.not.toBeNull();

		const ended = await setAdminPassword("second password here");

		expect(ended).toBe(1);
		// A password change that left other sessions alive would revoke nothing, which is
		// usually the whole reason for changing it.
		await expect(resolveSession(session.token)).resolves.toBeNull();
	});
});
