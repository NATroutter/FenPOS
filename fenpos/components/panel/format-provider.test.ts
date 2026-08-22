import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Pins down the shape of the fix for the module-layer bug this component exists to work around —
 * see `format-provider.tsx`'s own doc comment for the mechanism.
 *
 * This project's Vitest config runs in a Node environment with no React rendering harness (see
 * `vitest.config.mts`'s comment), so this cannot render `FormatProvider` and assert on hydration
 * output the way the browser pass did. What it *can* do is read the source and assert on the two
 * facts the whole fix depends on: that this file is compiled into the Client Component module
 * layer (`"use client"`), and that it actually calls `setFormatting`. Either one silently missing —
 * a stray blank line before the directive, a refactor that moved the call into a `useEffect` and
 * reopened the exact hydration mismatch this component exists to prevent — would put the bug back
 * without any other test in this suite noticing, since the unit tests for `setFormatting` itself
 * exercise a single module instance and cannot see the layer boundary at all.
 *
 * This is real but partial coverage. The browser pass — set `fi-FI`/`24h`/`Europe/Helsinki`, reload
 * `/jobs` and `/logs`, confirm the timestamps actually change and the console stays clean — is what
 * proves the mechanism works end to end; see the task report for that evidence.
 */
describe("FormatProvider", () => {
	const source = readFileSync(new URL("./format-provider.tsx", import.meta.url), "utf8");

	it("is a Client Component", () => {
		// Must be the first statement — a "use client" directive anywhere else in the file is not
		// a directive at all, just a string literal, and compiles the module into the wrong layer.
		expect(source.trimStart().startsWith('"use client";')).toBe(true);
	});

	it("calls setFormatting from datetime.ts, not applyPushedSettings or a Server Action", () => {
		expect(source).toMatch(/import\s*\{\s*setFormatting\s*\}\s*from\s*"@\/lib\/format\/datetime"/);
		expect(source).toMatch(/setFormatting\(\s*\{/);
	});

	it("calls setFormatting in the render body, not inside useEffect", () => {
		// The bug this guards against: moving the call into an effect would still compile and still
		// pass every other test, but the first paint would format with stale options and only
		// correct itself on the next tick — the hydration mismatch this component exists to avoid.
		// Matches an actual `useEffect(` call or import, not the word appearing in a doc comment
		// explaining why one is not used.
		expect(source).not.toMatch(/\buseEffect\s*\(/);
		expect(source).not.toMatch(/\{[^}]*\buseEffect\b[^}]*\}\s*from\s*"react"/);
	});
});
