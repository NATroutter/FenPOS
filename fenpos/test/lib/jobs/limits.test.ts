import { describe, expect, it } from "vitest";
import { effectiveLimits } from "@/lib/jobs/limits";
import { DEFAULT_LIMITS } from "@/lib/settings/settings-service";

const NONE = {
	maxLines: null,
	maxLineChars: null,
	maxTotalChars: null,
	maxOutputLines: null,
	maxBlockDepth: null,
	maxTableCells: null,
	maxSeriesPoints: null,
	maxRasterMb: null,
	maxFontHeight: null,
};

describe("effectiveLimits", () => {
	it("follows the install when the device overrides nothing", () => {
		expect(effectiveLimits(NONE, DEFAULT_LIMITS)).toEqual(DEFAULT_LIMITS);
	});

	it("lets a device narrow one limit", () => {
		expect(effectiveLimits({ ...NONE, maxRasterMb: 1 }, DEFAULT_LIMITS).maxRasterBytes).toBe(1024 * 1024);
		expect(effectiveLimits({ ...NONE, maxBlockDepth: 2 }, DEFAULT_LIMITS).maxBlockDepth).toBe(2);
	});
});
