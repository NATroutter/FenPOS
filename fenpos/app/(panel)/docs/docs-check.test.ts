import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { PERMISSION_IDS } from "@/lib/domain/permissions";
import { TAGS } from "@/lib/markup/tags";

/**
 * What the docs pages claim, checked against what the code does.
 *
 * Neither page can be rendered here — vitest runs in a Node environment and takes `**\/*.test.ts`
 * only, because everything else under test in this project is server-side logic. So the pages are
 * read as text and the parts of them that are *data* are checked against the modules that own that
 * data: the tag table against `TAGS`, and the worked examples against the compiler itself.
 *
 * The examples matter most. A reference whose sample is markup the language would refuse is worse
 * than one with no sample, because the reader trusts it and pastes it. Both examples are therefore
 * run through the same server action the Tools tab's Preview button calls, against a real device
 * row, and are required to compile clean.
 */

// The session guard redirects, and a redirect is not what this file is about. Everything
// downstream of it is the real pipeline against the real database.
vi.mock("@/lib/auth/require-session", () => ({
	requireSession: async () => {},
}));

const { preview } = await import("@/app/(panel)/tools/actions");
const { createAsset } = await import("@/lib/assets/asset-service");

const API_PAGE = readFileSync("app/(panel)/docs/api/page.tsx", "utf8");
const MARKUP_PAGE = readFileSync("app/(panel)/docs/markup/page.tsx", "utf8");

/** A real 128x40 PNG, the same fixture the dither and asset tests use. */
const LOGO_PNG = readFileSync("test/fixtures/logo.png");

/**
 * The elements of the first `"data": [ … ]` array in a page's source.
 *
 * Both worked examples write their elements as a JSON array — one inside a `curl` body on the API
 * page, one as a bare `data` array on the markup page — so one extractor reads both. The array's
 * contents are pure JSON with no interpolation in them, which is what makes parsing it honest: the
 * `${base}` and `${agentName}` the API page interpolates are all outside the brackets.
 *
 * @param source the page's own text
 * @param from the offset to start looking from
 * @returns the elements, exactly as the page prints them
 */
function dataElements(source: string, from = 0): string[] {
	const open = source.indexOf('"data": [', from);
	expect(open, "the page has no worked example with a data array").toBeGreaterThan(-1);
	const start = source.indexOf("[", open);
	const end = source.indexOf("]", start);
	expect(end).toBeGreaterThan(start);

	const elements: unknown = JSON.parse(source.slice(start, end + 1));
	expect(Array.isArray(elements)).toBe(true);
	return elements as string[];
}

/** The markup page's example, which is a bare array rather than a `data` field. */
function markupExample(): string[] {
	const open = MARKUP_PAGE.indexOf('<CodeBlock label="data">');
	expect(open, "the markup page's example has been renamed or removed").toBeGreaterThan(-1);
	const start = MARKUP_PAGE.indexOf("[", open);
	const end = MARKUP_PAGE.indexOf("]", start);
	expect(end).toBeGreaterThan(start);

	const elements: unknown = JSON.parse(MARKUP_PAGE.slice(start, end + 1));
	expect(Array.isArray(elements)).toBe(true);
	return elements as string[];
}

/**
 * A device to compile against: 42 columns, which is the width the other example suites use.
 *
 * @param name a name unique to the calling test
 * @returns the device row's id
 */
async function device(name: string): Promise<string> {
	const agent = await prisma.agent.create({ data: { name: `docs-${name}-${process.pid}` } });
	const row = await prisma.device.create({
		data: { agentId: agent.id, name: `docs-${name}`, port: "COM12", columns: 42 },
	});
	return row.id;
}

/**
 * Every permission some route under `app/api` actually requires, read from the routes themselves.
 *
 * Walked rather than listed, so a route file added tomorrow is covered without anyone remembering
 * to add it here — the whole point being that the page's claim cannot quietly stop matching the
 * code. The routes are read as text for the same reason the pages are: they are Next.js server
 * modules and this suite is a plain Node environment.
 *
 * @returns the permission identifiers passed to `requirePermission`
 */
function permissionsRoutesRequire(): string[] {
	const routes = readdirSync("app/api", { recursive: true, encoding: "utf8" }).filter((entry) =>
		entry.endsWith("route.ts"),
	);
	expect(routes.length, "no route files were found under app/api — has the walk broken?").toBeGreaterThan(0);

	const required = new Set<string>();
	for (const route of routes) {
		const source = readFileSync(`app/api/${route}`, "utf8");
		for (const call of source.matchAll(/requirePermission\([^,)]+,\s*"([^"]+)"\)/g)) {
			required.add(call[1]);
		}
	}

	expect(
		required.size,
		"no requirePermission call was found in any route — has the call been renamed?",
	).toBeGreaterThan(0);
	return [...required].sort();
}

/**
 * The `ENFORCED` array as the API page declares it.
 *
 * @returns the permission identifiers the page claims an endpoint checks
 */
function enforcedOnPage(): string[] {
	const declaration = API_PAGE.match(/const ENFORCED: readonly Permission\[\] = \[([^\]]*)\]/);
	expect(declaration, "the API page no longer declares ENFORCED").not.toBeNull();

	const names = [...(declaration?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1]);
	expect(names.length, "the API page's ENFORCED array is empty").toBeGreaterThan(0);
	return names.sort();
}

/**
 * The API page's claim about which permissions buy an integrator something.
 *
 * The page renders all six permissions, which is right — they are all grantable — and says beside
 * them that only some are checked by an endpoint. Nothing in the code registers that fact, so the
 * sentence is the only place it is written down and this is what keeps it honest in both
 * directions: a permission claimed here that no route wants, and a route requiring one the page
 * does not mention, are both a docs page lying to someone deciding what to grant a key.
 */
describe("the API page's enforced permissions", () => {
	it("name exactly the permissions the routes require", () => {
		expect(enforcedOnPage()).toEqual(permissionsRoutesRequire());
	});

	it("are all real permissions", () => {
		// The page's own type says so, but this reads the array back out of the source as text, where
		// nothing is typed. A typo here would render a chip naming a grant no key can hold.
		for (const name of enforcedOnPage()) {
			expect(PERMISSION_IDS, `ENFORCED names "${name}" and no such permission exists`).toContain(name);
		}
	});
});

describe("the markup page's tag table", () => {
	it("has a row for every tag the language defines", () => {
		const names = Object.keys(TAGS);
		expect(names.length, "TAGS is empty").toBeGreaterThan(0);

		for (const name of names) {
			// Anchored on `syntax:` so this can only be satisfied by a row of the table. Unanchored,
			// `<fill>` would be found in the worked example further down the page and the row could be
			// deleted without this noticing.
			expect(MARKUP_PAGE, `<${name}> is a real tag and the table does not list it`).toMatch(
				new RegExp(`syntax: "<${name}[=>]`),
			);
		}
	});

	it("has no row for a tag the language does not define", () => {
		// The `syntax` column of every row, as the page writes it: `<name…`.
		const listed = [...MARKUP_PAGE.matchAll(/syntax: "&lt;|syntax: "<([a-z0-9]+)/g)]
			.map((match) => match[1])
			.filter((name): name is string => Boolean(name));

		expect(listed.length, "no tag rows were found — has the table's shape changed?").toBeGreaterThan(10);
		for (const name of listed) {
			expect(TAGS, `the table lists <${name}> and the language has no such tag`).toHaveProperty(name);
		}
	});

	it("lists <fill>", () => {
		expect(MARKUP_PAGE).toContain('syntax: "<fill>"');
	});
});

describe("the worked examples", () => {
	it("compiles the API page's receipt clean", async () => {
		const deviceId = await device("api");
		const elements = dataElements(API_PAGE);

		const result = await preview(deviceId, elements.join("\n"));

		expect(result.errors, `the API page's example does not compile: ${JSON.stringify(result.errors)}`).toEqual([]);
	});

	/**
	 * The example's whole point: a label on the left and an amount on the right, with `<fill>`
	 * spending whatever the paper's width leaves over. Asserted on the rendered line rather than on
	 * the markup, because the markup compiling proves nothing about where the amount landed.
	 */
	it("puts the API page's totals against the right margin", async () => {
		const deviceId = await device("api-fill");
		const result = await preview(deviceId, dataElements(API_PAGE).join("\n"));

		const text = (result.lines ?? []).map((line) => line.spans.map((span) => span.text).join(""));
		const total = text.find((line) => line.startsWith("Total"));

		expect(total, "the example no longer prints a Total line").toBeDefined();
		expect(total).toHaveLength(42);
		expect(total?.endsWith("5.50")).toBe(true);
		expect(total).toBe(`Total${" ".repeat(42 - "Total".length - "5.50".length)}5.50`);
	});

	it("compiles the markup page's blocks receipt clean, with the image resolved", async () => {
		// Cleared first rather than created blind: the fixture database is per process, not per file,
		// and another suite that stored a `logo` and did not remove it would make this a name clash
		// rather than a test.
		await prisma.asset.deleteMany({ where: { name: "logo" } });
		await createAsset("logo", LOGO_PNG);
		const deviceId = await device("markup");
		const elements = markupExample();

		const result = await preview(deviceId, elements.join("\n"));

		expect(result.errors, `the markup page's example does not compile: ${JSON.stringify(result.errors)}`).toEqual([]);

		const blocks = (result.lines ?? []).flatMap((line) => line.blocks);
		expect(blocks.filter((block) => block.kind === "IMAGE").map((block) => block.ref)).toEqual(["logo"]);
		expect(blocks.filter((block) => block.kind === "SYMBOL")).toHaveLength(2);
	});
});
