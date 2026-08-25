import { describe, expect, it } from "vitest";
import { envSchema } from "@/lib/env";

/**
 * The environment contract.
 *
 * `lib/env.ts` parses at import time and refuses to start on a bad value, so these assertions
 * are about what "bad" means rather than about the parsing mechanism.
 */
describe("envSchema", () => {
	const base = { DATABASE_URL: "file:./data/test.db", BETTER_AUTH_SECRET: "x".repeat(32) };

	it("accepts a complete environment", () => {
		expect(envSchema.safeParse(base).success).toBe(true);
	});

	it("refuses a missing auth secret", () => {
		const { BETTER_AUTH_SECRET: _omitted, ...without } = base;
		expect(envSchema.safeParse(without).success).toBe(false);
	});

	it("refuses an auth secret short enough to brute force", () => {
		expect(envSchema.safeParse({ ...base, BETTER_AUTH_SECRET: "short" }).success).toBe(false);
	});

	it("accepts an absent public URL, which means derive it from the request", () => {
		expect(envSchema.safeParse(base).data?.BETTER_AUTH_URL).toBeUndefined();
	});
});
