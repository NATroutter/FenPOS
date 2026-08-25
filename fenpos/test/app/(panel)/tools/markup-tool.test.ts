import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { bundledLogoRaster } from "@/lib/assets/bundled-logo";
import { rasterToPngDataUrl } from "@/lib/assets/preview";
import { prisma } from "@/lib/db";

// The session guard redirects, and a redirect is not what this file is about. Everything
// downstream of it is the real pipeline against the real database.
vi.mock("@/lib/auth/require-session", () => ({
	requireSession: async () => ({
		id: "test-user",
		name: "Test User",
		email: "test@example.com",
		isSuperuser: true,
		mustChangePassword: false,
	}),
	currentUser: async () => ({
		id: "test-user",
		name: "Test User",
		email: "test@example.com",
		isSuperuser: true,
		mustChangePassword: false,
	}),
}));

const { preview } = await import("@/app/(panel)/tools/actions");

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
 * Just the `EXAMPLES` array, for the checks that go looking for examples by label.
 *
 * Narrowed to the array rather than scanning the whole file, because `label:` is an ordinary field
 * name — the toolbar's tag menus use it too. Scanning the module picked those up as examples and
 * then sliced a real example's source short at the first menu entry. Anything reading a module-level
 * constant still reads {@link MARKUP_TOOL}; only the label scan is scoped.
 */
const EXAMPLES_SOURCE = (() => {
	const from = MARKUP_TOOL.indexOf("const EXAMPLES: Example[] = [");
	const to = MARKUP_TOOL.indexOf("\n];", from);
	expect(from, "the EXAMPLES array has been renamed or removed").toBeGreaterThan(-1);
	expect(to).toBeGreaterThan(from);
	return MARKUP_TOOL.slice(from, to);
})();

/**
 * The example's own text, cut out of the module.
 *
 * Sliced rather than searched whole: `<hr>` and `<cut>` appear in every example here, so a check
 * against the file would pass on lines belonging to some other one.
 */
const EXAMPLE = (() => {
	const from = EXAMPLES_SOURCE.indexOf('label: "Device test page"');
	const to = EXAMPLES_SOURCE.indexOf('label: "Wrapping"');
	expect(from, "the Device test page example has been renamed or removed").toBeGreaterThan(-1);
	expect(to).toBeGreaterThan(from);
	return EXAMPLES_SOURCE.slice(from, to);
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

/** The value of a `const … = "…"` in this package's TypeScript. */
function tsConstant(name: string): string {
	const match = MARKUP_TOOL.match(new RegExp(`const ${name} = "([^"]*)"`));
	expect(match, `${name} is not a plain string constant any more`).not.toBeNull();
	return (match as RegExpMatchArray)[1];
}

/**
 * The value of a `const … = \`…\`` template literal in this package's TypeScript.
 *
 * Separate from {@link tsConstant} because a template literal spans lines — `SAMPLE` is a whole
 * receipt — and a regex anchored to a single line would stop at the first newline inside it.
 */
function tsTemplateConstant(name: string): string {
	const match = MARKUP_TOOL.match(new RegExp(`const ${name} = \`([\\s\\S]*?)\`;`));
	expect(match, `${name} is not a plain template literal any more`).not.toBeNull();
	return (match as RegExpMatchArray)[1];
}

/**
 * `ruler`, copied from the module because it is private to it.
 *
 * A copy is acceptable here for the same reason the text comparisons above are: what this file
 * checks is the example, and the ruler is one of the parts `TestPage.java` and this both *compute*
 * rather than quote — already outside the comparison by construction, and covered on the Java side
 * by `TestPageTest`.
 */
function ruler(columns: number): string {
	let out = "";
	for (let column = 1; column <= columns; column++) {
		out += column % 10 === 0 ? String(Math.floor(column / 10) % 10) : column % 5 === 0 ? "+" : ".";
	}
	return out;
}

/**
 * The example's elements, read out of the module's source and evaluated for a device.
 *
 * The module is a client component and importing it into a Node test would drag in the editor; the
 * elements themselves are one string literal or template per line, so they can be read directly.
 * Anything this cannot evaluate is thrown on rather than skipped — an element quietly dropped here
 * would be an element the preview below never exercises.
 *
 * @param device the values the example interpolates
 * @param source the example's own source, defaulting to the Device test page for the tests below
 *   that were written before any other example needed this
 * @returns one element per line, exactly as the Examples menu would insert them
 */
function exampleElements(
	device: { deviceName: string; columns: number; codepage: string },
	source: string = EXAMPLE,
): string[] {
	const open = source.indexOf("[");
	const close = source.indexOf('].join("\\n")');
	expect(open, "the example is not an array literal any more").toBeGreaterThan(-1);
	expect(close).toBeGreaterThan(open);

	return source
		.slice(open + 1, close)
		.split("\n")
		.map((line) => line.trim().replace(/,$/, ""))
		.filter((line) => line.length > 0)
		.map((entry) => {
			if (entry === "ruler(device.columns)") {
				return ruler(device.columns);
			}
			if (entry === "CODEPAGE_SAMPLE") {
				return tsConstant("CODEPAGE_SAMPLE");
			}
			const quoted = /^(["`])([\s\S]*)\1$/.exec(entry);
			expect(quoted, `the example writes an element this test cannot evaluate: ${entry}`).not.toBeNull();
			return (quoted as RegExpExecArray)[2]
				.replaceAll("${device.deviceName}", device.deviceName)
				.replaceAll("${device.columns}", String(device.columns))
				.replaceAll("${device.codepage}", device.codepage)
				.replaceAll("${BUNDLED_LOGO}", tsConstant("BUNDLED_LOGO"));
		});
}

/** Every label the Examples menu offers, read out in the order the module defines them. */
function exampleLabels(): string[] {
	return [...EXAMPLES_SOURCE.matchAll(/label: "([^"]*)"/g)].map((match) => match[1]);
}

/**
 * One example's own source, from its label up to the next one's (or the end of the file for the
 * last example).
 *
 * Slicing rather than parsing the object literal, for the same reason {@link EXAMPLE} above does:
 * this is a text comparison against the module's source, not an evaluation of it.
 */
function exampleSource(label: string): string {
	const labels = exampleLabels();
	const index = labels.indexOf(label);
	expect(index, `no example is labelled ${JSON.stringify(label)}`).toBeGreaterThanOrEqual(0);

	const from = EXAMPLES_SOURCE.indexOf(`label: "${label}"`);
	const to =
		index + 1 < labels.length ? EXAMPLES_SOURCE.indexOf(`label: "${labels[index + 1]}"`) : EXAMPLES_SOURCE.length;
	return EXAMPLES_SOURCE.slice(from, to);
}

/**
 * The markup one example would load into the editor, built the same way the Examples menu builds
 * it for the given device.
 *
 * Two shapes exist among the examples. Most build an array of lines and join them, which
 * {@link exampleElements} already evaluates for the Device test page; "Café receipt" instead
 * returns {@link SAMPLE} — a template literal constant — directly, so that shape is read out on
 * its own rather than forced through the array parser.
 */
function exampleMarkup(label: string, device: { deviceName: string; columns: number; codepage: string }): string {
	const source = exampleSource(label);
	if (source.includes("build: () => SAMPLE")) {
		return tsTemplateConstant("SAMPLE");
	}
	return exampleElements(device, source).join("\n");
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

	/**
	 * The bug this example used to carry: loading it and pressing Preview reported
	 * `line 23  unknown_asset  There is no image called 'fenpos'.`
	 *
	 * The panel could not reach the rasters bundled in the agent's jar, so the one example that
	 * exists to be compared against real paper could not be rendered at all. It now resolves the
	 * reserved name from `public/fenpos-logo.png` through the same ditherer, and this drives the
	 * very server action the button calls, over the example's own elements.
	 */
	it("previews on a 42-column printer with the logo drawn, not reported missing", async () => {
		const agent = await prisma.agent.create({ data: { name: `example-${process.pid}` } });
		const device = await prisma.device.create({
			data: { agentId: agent.id, name: "example-counter", port: "COM9", columns: 42 },
		});

		const elements = exampleElements({
			deviceName: device.name,
			columns: device.columns,
			codepage: device.codepage,
		});
		// The element the failure named. Stated rather than searched for, so that the example
		// growing a line above it is something this notices instead of quietly following.
		expect(elements[22]).toBe("<align=center><image>fenpos</image></align>");

		const result = await preview(device.id, elements.join("\n"));

		expect(result.errors).toEqual([]);
		const images = (result.lines ?? []).flatMap((line) => line.blocks).filter((block) => block.kind === "IMAGE");
		expect(images).toHaveLength(1);
		expect(images[0].ref).toBe("fenpos");
		// The dots drawn are the dots the agent has bundled for 42 columns, which is what makes the
		// preview worth holding against the paper. `bundled-logo.test.ts` is what pins those to the
		// committed `.raster`; this checks the preview shows them rather than a rescale.
		expect(images[0].png).toBe(await rasterToPngDataUrl(await bundledLogoRaster(504)));
		expect(images[0].widthFraction).toBe(1);
	});

	it("names the image the agent bundles", () => {
		// The name is a constant on both sides — `BundledImages.NAME` there and `BUNDLED_LOGO`
		// here — so it is not among the literals above and has to be matched through its
		// declaration. The example is checked separately for actually using it.
		expect(MARKUP_TOOL).toContain(`const BUNDLED_LOGO = "${javaConstant(BUNDLED_IMAGES, "NAME")}"`);
		expect(EXAMPLE).toMatch(/<image>\$\{BUNDLED_LOGO\}<\/image>/);
	});
});

describe("every example", () => {
	/**
	 * Labels this suite cannot exercise, and why — named explicitly rather than skipped silently,
	 * so a reader can tell "excluded on purpose" from "the loop below forgot about it".
	 *
	 * Empty today: every example the menu currently offers evaluates through {@link exampleMarkup}
	 * and compiles against the fixture below. If a future example needs an asset this harness has
	 * no route to, or a device shape the fixture below cannot provide, name it here rather than
	 * letting it fall out of coverage unnoticed.
	 */
	const EXCLUDED: Record<string, string> = {};

	it("compiles every example the menu offers, except what is excluded above", async () => {
		const agent = await prisma.agent.create({ data: { name: `every-example-${process.pid}` } });
		const device = await prisma.device.create({
			data: { agentId: agent.id, name: "every-example", port: "COM11", columns: 42 },
		});

		const labels = exampleLabels();
		expect(labels.length, "the Examples menu is empty").toBeGreaterThan(0);

		for (const label of labels) {
			if (label in EXCLUDED) {
				continue;
			}

			const markup = exampleMarkup(label, {
				deviceName: device.name,
				columns: device.columns,
				codepage: device.codepage,
			});
			const result = await preview(device.id, markup);

			expect(result.errors, `"${label}" failed to compile: ${JSON.stringify(result.errors)}`).toEqual([]);
		}
	});
});
