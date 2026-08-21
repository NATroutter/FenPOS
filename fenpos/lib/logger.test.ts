import { afterEach, describe, expect, it, vi } from "vitest";
import { isProduction } from "@/lib/env";
import { logger, setMinimumLevel } from "@/lib/logger";

/**
 * Tests for the logger's level gate.
 *
 * `minimumLevel` is module state pushed in by `setMinimumLevel`, not read from a store here — see
 * that function's doc comment for why. The tests below exercise the gate directly, the way the
 * settings store exercises it in practice.
 */

/**
 * Runs `fn` with `process.stdout.write` stubbed, and returns the chunks it was called with.
 *
 * `write` (`logger.ts`) writes to `process.stdout` directly rather than through `console.*`, so
 * that is the seam stubbed here.
 *
 * @param fn the code to run with output captured
 * @returns one entry per call to `process.stdout.write` while `fn` ran
 */
function capture(fn: () => void): string[] {
	const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	try {
		fn();
		return spy.mock.calls.map((call) => String(call[0]));
	} finally {
		spy.mockRestore();
	}
}

describe("logger", () => {
	afterEach(() => {
		// Restores the module's own built-in default, so a level set by one test cannot leak
		// into the next.
		setMinimumLevel(isProduction ? "INFO" : "DEBUG");
	});

	it("uses the built-in level until one is pushed", () => {
		// A module that has never been told a level logs exactly as it did before this setting
		// existed. This is what makes the push safe for a unit test or an edge runtime that never
		// reaches instrumentation.
		const written = capture(() => logger.error("always"));
		expect(written).toHaveLength(1);
	});

	it("drops lines below the minimum level", () => {
		setMinimumLevel("WARN");
		const written = capture(() => logger.info("quiet"));
		expect(written).toHaveLength(0);
	});

	it("writes lines at or above the minimum level", () => {
		setMinimumLevel("WARN");
		const written = capture(() => logger.error("loud"));
		expect(written).toHaveLength(1);
	});
});
