import { describe, expect, it } from "vitest";
import { markupEdit } from "@/lib/markup/editing";

/**
 * The toolbar's edit rules.
 *
 * These assertions are about where the caret ends up as much as what gets written: the text is the
 * obvious half, and the half that goes unnoticed until someone types the next character into the
 * wrong place.
 */
describe("markupEdit", () => {
	it("wraps a selection and keeps it selected, so a second button styles the same words", () => {
		const edit = markupEdit("bold", "TOTAL");

		expect(edit?.insert).toBe("<bold>TOTAL</bold>");
		expect(edit?.insert.slice(edit.selectionFrom, edit.selectionTo)).toBe("TOTAL");
	});

	it("puts the caret between the halves when nothing is selected", () => {
		const edit = markupEdit("bold", "");

		expect(edit?.insert).toBe("<bold></bold>");
		expect(edit?.selectionFrom).toBe("<bold>".length);
		expect(edit?.selectionTo).toBe(edit?.selectionFrom);
	});

	it("writes the argument into the opening tag", () => {
		expect(markupEdit("size", "BIG", "2,2")?.insert).toBe("<size=2,2>BIG</size>");
		expect(markupEdit("align", "", "center")?.insert).toBe("<align=center></align>");
	});

	it("omits an empty argument rather than writing a bare =", () => {
		expect(markupEdit("underline", "x", "")?.insert).toBe("<underline>x</underline>");
	});

	it("keeps the selected text when a void tag is pressed, rather than replacing it", () => {
		// The failure this pins is silent data loss: a void tag encloses nothing, so replacing the
		// selection the way a paired tag does would delete what the person had highlighted.
		const edit = markupEdit("hr", "Thank you");

		expect(edit?.insert).toBe("Thank you<hr>");
		expect(edit?.selectionFrom).toBe(edit?.insert.length);
	});

	it("leaves the caret after a void tag inserted at a bare cursor", () => {
		const edit = markupEdit("feed", "", "3");

		expect(edit?.insert).toBe("<feed=3>");
		expect(edit?.selectionFrom).toBe("<feed=3>".length);
	});

	it("reports an unknown tag rather than inventing one", () => {
		expect(markupEdit("blink", "x")).toBeUndefined();
	});
});
