import { describe, expect, it } from "vitest";
import { logsDb, prisma } from "@/lib/db";

/**
 * The logs database is its own file.
 *
 * The property worth pinning is not that a row can be written — that is table stakes — but that it
 * is written *somewhere the application database cannot see*. A single shared file would pass any
 * test that only checked the write succeeded, and would silently reinstate the eviction this split
 * exists to prevent.
 */
describe("the logs database", () => {
	it("stores a line the application database has no table for", async () => {
		await logsDb.logEntry.create({ data: { level: "INFO", severity: 1, message: "separate file" } });

		const found = await logsDb.logEntry.findFirst({ where: { message: "separate file" } });
		expect(found?.message).toBe("separate file");

		// Goes red if both clients point at one file: the application database must not have the table.
		await expect(prisma.$queryRawUnsafe("SELECT 1 FROM log_entries LIMIT 1")).rejects.toThrow();
	});
});
