import { describe, expect, it } from "vitest";
import { describeBytes } from "@/lib/format/bytes";

/**
 * Tests for `describeBytes`, the one place a byte count is turned into something a person reads.
 *
 * The boundaries pinned here are the ones `assets.maxUploadKb` actually reaches: its declared
 * minimum (256 KiB) and maximum (8192 KiB), the KiB/MiB crossover a cap or a file can land on
 * either side of, and 0. `describeBytes` floors rather than rounds — asserted directly below,
 * because a formatter that rounded up would tell an operator a slightly larger file fits than
 * actually does, which is the opposite of what a refusal is for.
 */
describe("describeBytes", () => {
	it("states 0 as 0 KiB", () => {
		expect(describeBytes(0)).toBe("0 KiB");
	});

	it("floors just under 1 KiB rather than rounding up to it", () => {
		// 1023 / 1024 = 0.999...; a plain toFixed(1) would round this to "1.0", which claims a
		// whole KiB fits when 1023 bytes do not — that is the regression this test forbids.
		expect(describeBytes(1023)).toBe("0.9 KiB");
	});

	it("states exactly 1 KiB as a whole number, with no trailing .0", () => {
		expect(describeBytes(1024)).toBe("1 KiB");
	});

	it("pins the one-decimal rounding rule for a value between whole KiB", () => {
		expect(describeBytes(1536)).toBe("1.5 KiB");
	});

	it("states assets.maxUploadKb's declared minimum, 256 KiB, exactly", () => {
		expect(describeBytes(256 * 1024)).toBe("256 KiB");
	});

	it("stays in KiB just under the MiB crossover, however large the number reads", () => {
		// 1048575 bytes is one byte short of 1 MiB — still the KiB unit, not a MiB value that
		// rounds down to something smaller than the file actually is.
		expect(describeBytes(1024 * 1024 - 1)).toBe("1023.9 KiB");
	});

	it("crosses to MiB at exactly one mebibyte", () => {
		expect(describeBytes(1024 * 1024)).toBe("1 MiB");
	});

	it("states assets.maxUploadKb's declared maximum, 8192 KiB, as whole mebibytes", () => {
		expect(describeBytes(8192 * 1024)).toBe("8 MiB");
	});

	it("pins the one-decimal rounding rule in MiB too", () => {
		expect(describeBytes(1.5 * 1024 * 1024)).toBe("1.5 MiB");
	});
});
