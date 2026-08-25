import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";

/**
 * The schema is reachable through the client.
 *
 * Thin on purpose: this asserts that the migration ran and the generated client carries the new
 * models, which is the failure mode worth catching early. Behaviour lives in the tests for the
 * modules that own each table.
 */
describe("schema", () => {
	it("exposes the user table", async () => {
		expect(await prisma.user.count()).toBe(0);
	});

	it("exposes the setup key table", async () => {
		expect(await prisma.setupKey.findUnique({ where: { id: 1 } })).toBeNull();
	});

	it("no longer exposes the retired administrator table", () => {
		expect("adminAuth" in prisma).toBe(false);
	});
});
