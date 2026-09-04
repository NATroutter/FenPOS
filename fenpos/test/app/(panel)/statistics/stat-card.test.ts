import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, type MockInstance, test, vi } from "vitest";
import { Sparkline } from "@/app/(panel)/statistics/stat-card";

/**
 * A `ResponsiveContainer` starts out at its `initialDimension`, which recharts defaults to
 * `{ width: -1, height: -1 }`, and warns about that size on the very first render — before the
 * `ResizeObserver` has had a chance to measure anything. On the server there is no observer at all,
 * so the warning is all a server render ever produces, and it lands in the container logs.
 *
 * These tests render server-side on purpose: that is the path that writes to the logs.
 */

const SPARK = [
	{ t: "2026-09-01T00:00:00.000Z", v: 1 },
	{ t: "2026-09-01T01:00:00.000Z", v: 4 },
	{ t: "2026-09-01T02:00:00.000Z", v: 2 },
];

let warn: MockInstance<typeof console.warn>;

beforeEach(() => {
	warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	warn.mockRestore();
});

/** Every string recharts passed to `console.warn` during the render, joined for easy matching. */
function warnings(): string {
	return warn.mock.calls.map((call) => call.join(" ")).join("\n");
}

test("a sparkline renders on the server without warning about its size", () => {
	renderToStaticMarkup(createElement(Sparkline, { data: SPARK }));

	expect(warnings()).not.toContain("should be greater than 0");
});

test("a sparkline in a table cell keeps its caller's height", () => {
	const markup = renderToStaticMarkup(createElement(Sparkline, { data: SPARK, height: 28 }));

	expect(markup).toContain("height:28px");
	expect(warnings()).not.toContain("should be greater than 0");
});
