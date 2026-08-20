import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The one invariant the "Device test page" example carries: it must say what `TestPage.java` says.
 *
 * The example exists so an operator can hold this editor's preview against the page the agent
 * actually prints and have the difference mean something. The moment the two drift, the comparison
 * is worthless and — worse — silently worthless, because both still render.
 *
 * **What this checks and what it cannot.** Every string literal `TestPage.java` writes into its
 * `data` array, and the payloads it interpolates, must appear in this example. That catches the
 * realistic drift, which is a change made to the Java page and forgotten here: a retitled block, a
 * different QR payload, a tag added or renamed. It is a text comparison across two languages, not
 * an execution of either, so it cannot catch everything — a line *removed* from the Java page
 * leaves nothing behind to look for, and the parts the two sides compute rather than quote (the
 * ruler, the device's own name, the codepage sample) are outside it by construction. Those are
 * covered on the Java side by `TestPageTest` and are documented here as the gap they are.
 */

/** `TestPage.java`, which is the source of truth for what the page contains. */
const TEST_PAGE = readFileSync("../agent/src/main/java/fi/natroutter/fenpos/print/TestPage.java", "utf8");

/** `BundledImages.java`, which owns the name of the image the page prints. */
const BUNDLED_IMAGES = readFileSync("../agent/src/main/java/fi/natroutter/fenpos/print/BundledImages.java", "utf8");

/** This file's own source, since `EXAMPLES` is private to the module. */
const MARKUP_TOOL = readFileSync("app/(panel)/tools/markup-tool.tsx", "utf8");

/**
 * The example's own text, cut out of the module.
 *
 * Sliced rather than searched whole: `<hr>` and `<cut>` appear in every example here, so a check
 * against the file would pass on lines belonging to some other one.
 */
const EXAMPLE = (() => {
	const from = MARKUP_TOOL.indexOf('label: "Device test page"');
	const to = MARKUP_TOOL.indexOf('label: "Wrapping"');
	expect(from, "the Device test page example has been renamed or removed").toBeGreaterThan(-1);
	expect(to).toBeGreaterThan(from);
	return MARKUP_TOOL.slice(from, to);
})();

/** Every string literal `TestPage.java` adds to its `data` array. */
function elementLiterals(): string[] {
	const found: string[] = [];
	for (const line of TEST_PAGE.split("\n")) {
		if (!line.includes("lines.add(")) {
			continue;
		}
		for (const [, literal] of line.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
			found.push(literal);
		}
	}
	return found;
}

/** The value of a `private static final String` in a Java source. */
function javaConstant(source: string, name: string): string {
	const match = source.match(new RegExp(`${name}\\s*=\\s*\\n?\\s*"([^"]*)"`));
	expect(match, `${name} is not a plain string constant any more`).not.toBeNull();
	return (match as RegExpMatchArray)[1];
}

describe("the Device test page example", () => {
	it("writes every line TestPage.java writes", () => {
		const literals = elementLiterals();

		// A backslash would mean the literals need unescaping before they can be compared, which
		// this deliberately does not do — it would rather fail loudly than compare the wrong text.
		expect(literals.every((literal) => !literal.includes("\\"))).toBe(true);
		expect(literals.length).toBeGreaterThan(10);

		for (const literal of literals) {
			expect(EXAMPLE, `TestPage.java writes ${JSON.stringify(literal)} and this example does not`).toContain(literal);
		}
	});

	it("carries the same symbol payloads", () => {
		for (const name of ["QR_CONTENT", "BARCODE_CONTENT", "PDF417_CONTENT"]) {
			expect(EXAMPLE, `${name} has drifted`).toContain(javaConstant(TEST_PAGE, name));
		}
	});

	it("names the image the agent bundles", () => {
		// The name is a constant on both sides — `BundledImages.NAME` there and `BUNDLED_LOGO`
		// here — so it is not among the literals above and has to be matched through its
		// declaration. The example is checked separately for actually using it.
		expect(MARKUP_TOOL).toContain(`const BUNDLED_LOGO = "${javaConstant(BUNDLED_IMAGES, "NAME")}"`);
		expect(EXAMPLE).toMatch(/<image>\$\{BUNDLED_LOGO\}<\/image>/);
	});
});
