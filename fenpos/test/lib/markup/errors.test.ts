import { describe, expect, it } from "vitest";
import { API_ERROR_STATUS } from "@/lib/errors";
import { MARKUP_ERRORS, MarkupError } from "@/lib/markup/errors";

describe("MarkupError", () => {
	it("carries a line and a column", () => {
		const error = new MarkupError(MARKUP_ERRORS.unclosedTag, 3, 7, "bold", "Tag <bold> was never closed");

		expect(error.line).toBe(3);
		expect(error.column).toBe(7);
		expect(error.code).toBe("unclosed_tag");
		expect(error.name).toBe("MarkupError");
	});

	it("has a public status for every code", () => {
		for (const code of Object.values(MARKUP_ERRORS)) {
			expect(API_ERROR_STATUS, `${code} has no status`).toHaveProperty(code);
		}
	});

	it("buckets the limit codes as 413 and the rest as 422", () => {
		expect(API_ERROR_STATUS.nesting_too_deep).toBe(413);
		expect(API_ERROR_STATUS.too_many_cells).toBe(413);
		expect(API_ERROR_STATUS.too_many_points).toBe(413);
		expect(API_ERROR_STATUS.raster_budget_exceeded).toBe(413);
		expect(API_ERROR_STATUS.unknown_attribute).toBe(422);
		expect(API_ERROR_STATUS.invalid_attribute).toBe(422);
		expect(API_ERROR_STATUS.misplaced_block).toBe(422);
		expect(API_ERROR_STATUS.too_many_labels).toBe(422);
		expect(API_ERROR_STATUS.unknown_font).toBe(422);
		expect(API_ERROR_STATUS.invalid_image_data).toBe(422);
		expect(API_ERROR_STATUS.invalid_font).toBe(422);
	});
});
