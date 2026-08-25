import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { createApiKey, listApiKeys } from "@/lib/keys/key-service";

/**
 * Who minted a key, kept beside the key rather than behind a relation.
 *
 * The property worth pinning is the one a foreign key would break: deleting the account that
 * created a key must leave the key working and still naming its creator. An operator looking at a
 * live credential needs to know who put it there, and that question outlives the person.
 */
describe("createApiKey", () => {
	beforeEach(async () => {
		await prisma.apiKey.deleteMany({});
		await prisma.session.deleteMany({});
		await prisma.account.deleteMany({});
		await prisma.user.deleteMany({});
	});

	async function minter(id: string) {
		return prisma.user.create({ data: { id, name: `Minter ${id}`, email: `${id}@example.com` } });
	}

	it("records the account that minted the key, by id and by name", async () => {
		const user = await minter("k1");

		await createApiKey("till", ["print"], [], { id: user.id, name: user.name });

		const [key] = await listApiKeys();
		expect(key.createdByUserId).toBe(user.id);
		expect(key.createdByName).toBe("Minter k1");
	});

	it("keeps the key, and the name, after the account is deleted", async () => {
		const user = await minter("k2");
		await createApiKey("till", ["print"], [], { id: user.id, name: user.name });

		await prisma.user.delete({ where: { id: user.id } });

		const [key] = await listApiKeys();
		expect(key.createdByName).toBe("Minter k2");
		expect(key.revokedAt).toBeNull();
	});
});
