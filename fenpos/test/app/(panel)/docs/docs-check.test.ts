import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { API_ROUTES } from "@/lib/api/api-routes";
import { describeVerification } from "@/lib/audit/verify";
import { prisma } from "@/lib/db";
import { PANEL_PERMISSION_IDS } from "@/lib/domain/panel-permissions";
import { PERMISSION_IDS } from "@/lib/domain/permissions";
import { TAGS } from "@/lib/markup/tags";
import { SETTING_KEYS } from "@/lib/settings/settings-service";

/**
 * What the docs pages claim, checked against what the code does.
 *
 * Neither page can be rendered here — vitest runs in a Node environment and takes
 * `test/**\/*.test.ts` only, because everything else under test in this project is server-side
 * logic. So the pages are read as text and the parts of them that are *data* are checked against
 * the modules that own that data: the tag table against `TAGS`, and the worked examples against
 * the compiler itself.
 *
 * The examples matter most. A reference whose sample is markup the language would refuse is worse
 * than one with no sample, because the reader trusts it and pastes it. Both examples are therefore
 * run through the same server action the Tools tab's Preview button calls, against a real device
 * row, and are required to compile clean.
 */

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
const { createAsset } = await import("@/lib/assets/asset-service");

const API_PAGE = readFileSync("app/(panel)/docs/api/page.tsx", "utf8");
const MARKUP_PAGE = readFileSync("app/(panel)/docs/markup/page.tsx", "utf8");
const SECURITY_PAGE = readFileSync("app/(panel)/docs/security/page.tsx", "utf8");

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
 * Every permission some route under `app/api` actually requires.
 *
 * **The v1 permissions come from `API_ROUTES`, because that is where the check now lives.** A v1
 * handler no longer calls `requirePermission` itself; `apiRoute` does, reading the permission from
 * the registry entry whose id the handler names. The property this function was written for is
 * unchanged — a route added tomorrow is covered without anyone remembering to add it here — because
 * `test/lib/api/route-coverage.test.ts` fails on a handler with no registry entry, so the registry
 * cannot fall behind `app/api/v1/`.
 *
 * **The walk over the route files stays, for everything outside that registry.** Nothing under
 * `app/api` but v1 gates on an API key today, and the point of walking rather than listing is that a
 * route which starts to must be counted rather than exempted by the source of truth having moved.
 * Those files are read as text for the same reason the pages are: they are Next.js server modules
 * and this suite is a plain Node environment.
 *
 * @returns the permission identifiers a caller must hold to reach some endpoint
 */
function permissionsRoutesRequire(): string[] {
	const routes = readdirSync("app/api", { recursive: true, encoding: "utf8" }).filter((entry) =>
		entry.endsWith("route.ts"),
	);
	expect(routes.length, "no route files were found under app/api — has the walk broken?").toBeGreaterThan(0);

	const required = new Set<string>(API_ROUTES.map((entry) => entry.permission));
	expect(required.size, "API_ROUTES declares no permissions — has the registry been emptied?").toBeGreaterThan(0);

	for (const route of routes) {
		const source = readFileSync(`app/api/${route}`, "utf8");
		for (const call of source.matchAll(/requirePermission\([^,)]+,\s*"([^"]+)"\)/g)) {
			required.add(call[1]);
		}
	}

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

describe("every versioned endpoint is documented", () => {
	/**
	 * Every path the page declares, as the suffix it writes after `API_BASE`.
	 *
	 * The regex scans the whole page rather than the text of `SECTIONS` specifically — the pattern
	 * `path: \`${API_BASE}...\`` is anchored on the field name, not on which array it sits in, so
	 * this can only be satisfied by a `path` field a reader actually sees, the same anchoring the
	 * tag table uses on `syntax:` below. The page never writes the version prefix literally, so
	 * neither does this: a route is checked against what the page declares after `API_BASE`, not
	 * against a hardcoded `/api/v1`.
	 *
	 * This makes the check below one-directional: it fails a route file that has no matching
	 * `path:`, but a `path:` naming a route that does not exist under `app/api/v1` would pass
	 * silently. Nothing here reads the two lists as sets and diffs them both ways.
	 *
	 * @returns the declared paths, e.g. `/devices/{agent}/{device}`
	 */
	function declaredPaths(): string[] {
		const paths = [...API_PAGE.matchAll(/path: `\$\{API_BASE\}([^`]*)`/g)].map((match) => match[1]);
		expect(paths.length, "no section paths were found — has SECTIONS changed shape?").toBeGreaterThan(0);
		return paths;
	}

	/**
	 * A route file's directory under `app/api/v1`, as the suffix an integrator calls after
	 * `API_BASE`.
	 *
	 * Next's bracket segments are turned back into the `{name}` form the docs page writes, so the
	 * comparison is against what a reader sees rather than against a filesystem detail.
	 *
	 * @param routeFile a path under `app/api/v1`, e.g. `devices/[agent]/[device]/route.ts`
	 * @returns the suffix after `API_BASE`, e.g. `/devices/{agent}/{device}`
	 */
	function routeSuffix(routeFile: string): string {
		const directory = routeFile.replace(/[\\/]route\.ts$/, "");
		return `/${directory.replaceAll("\\", "/").replace(/\[(\.\.\.)?([^\]]+)\]/g, "{$2}")}`;
	}

	it("declares every route under /api/v1 in SECTIONS", () => {
		const routes = readdirSync("app/api/v1", { recursive: true, encoding: "utf8" }).filter((entry) =>
			/route\.ts$/.test(entry),
		);

		expect(routes.length).toBeGreaterThan(0);

		const declared = declaredPaths();
		for (const route of routes) {
			const suffix = routeSuffix(route);
			expect(declared, `/api/v1${suffix} is not declared in SECTIONS`).toContain(suffix);
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

/**
 * One code sample from the security page, by the label printed above it.
 *
 * The samples hold no backtick of their own, so the template literal that carries one is delimited by
 * the first two after the label — which is what lets this read a sample written on its own line as
 * readily as one written inline after the tag.
 *
 * @param label the sample's `CodeBlock` label
 * @returns the sample exactly as the page prints it
 */
function securitySample(label: string): string {
	const at = SECURITY_PAGE.indexOf(`<CodeBlock label="${label}">`);
	expect(at, `the security page has no code sample labelled "${label}"`).toBeGreaterThan(-1);

	const open = SECURITY_PAGE.indexOf("`", at);
	const close = SECURITY_PAGE.indexOf("`", open + 1);
	expect(close, "the sample's template literal is not closed").toBeGreaterThan(open);
	return SECURITY_PAGE.slice(open + 1, close);
}

/**
 * The security page's `pnpm audit:verify` samples, against the function that prints them.
 *
 * This is the one claim on that page an operator checks their own terminal against, and it was wrong
 * before this: the page showed the intact sentence without the `(N from archives, M live)` split
 * `describeVerification` has printed since archiving landed, and showed no sample of the incomplete
 * state at all. Prose discipline is what let that happen, so the sentences are pinned to the function
 * rather than proof-read against it — a wording change in `describeVerification` now fails here.
 *
 * The fixtures are internally consistent runs of one install: 4218 events, of which seq 1–3800 have
 * been archived and 3801–4218 are live, and archiving is complete from seq 1402 in the incomplete
 * case. The equality is what pins the page; the arithmetic is what makes the numbers a reader sees
 * add up.
 */
describe("the security page's audit:verify samples", () => {
	it("prints an intact chain exactly as the command does", () => {
		expect(securitySample("pnpm audit:verify — chain intact")).toBe(
			describeVerification({ ok: true, checked: 4218, archived: 3800, live: 418, firstSeq: 1, lastSeq: 4218 }),
		);
	});

	it("prints an incomplete chain exactly as the command does", () => {
		expect(securitySample("pnpm audit:verify — intact as far back as the record goes")).toBe(
			describeVerification({
				ok: "incomplete",
				checked: 2817,
				archived: 2399,
				live: 418,
				verifiedFrom: 1402,
				firstSeq: 1402,
				lastSeq: 4218,
			}),
		);
	});

	it("prints a broken chain exactly as the command does", () => {
		expect(securitySample("pnpm audit:verify — chain broken")).toBe(
			describeVerification({ ok: false, checked: 2090, brokenAt: 2091, reason: "hash-mismatch" }),
		);
	});
});

/**
 * Every setting a reference page names, as the page writes it.
 *
 * Anchored on the whole of a `<Mono>` or a `label=` value rather than searched for loosely, so this
 * can only be satisfied by a name a reader actually sees — the same anchoring the tag table's check
 * uses. Anchoring is also what keeps it quiet: `pnpm auth:recover`, `audit-2026-01.db.gz` and
 * `DATABASE_URL` all sit in a `<Mono>` on these pages and none of them is a setting.
 *
 * @param source the page's own text
 * @returns the setting keys it names, each once
 */
function settingsNamed(source: string): string[] {
	const found = new Set<string>();
	for (const match of source.matchAll(/<Mono>([a-z]+\.[a-zA-Z0-9]+)<\/Mono>/g)) {
		found.add(match[1]);
	}
	for (const match of source.matchAll(/label="([a-z]+\.[a-zA-Z0-9]+)"/g)) {
		found.add(match[1]);
	}
	return [...found].sort();
}

/**
 * The names these pages hand an operator to go and look for.
 *
 * A settings key or a permission id that does not exist sends somebody to the Settings or Roles tab
 * to hunt for a row that was renamed or withdrawn, which is the shape of documentation failure this
 * branch produced most: `logs.sweepEvery` and `audit.sweepEvery` were both real when these pages were
 * last edited and are neither of them settings now.
 */
describe("what the reference pages name", () => {
	it("names only settings this build has", () => {
		const named = [...settingsNamed(API_PAGE), ...settingsNamed(SECURITY_PAGE)];
		expect(named.length, "no settings were found on either page — has the markup changed shape?").toBeGreaterThan(10);

		for (const key of named) {
			expect(SETTING_KEYS, `a docs page names "${key}" and no such setting exists`).toContain(key);
		}
	});

	it("names only permissions the panel defines", () => {
		const named = new Set<string>();
		for (const match of SECURITY_PAGE.matchAll(/<Mono>([a-z]+:[a-z0-9:-]+)<\/Mono>/g)) {
			named.add(match[1]);
		}

		expect(named.size, "no permissions were found on the security page").toBeGreaterThan(0);
		for (const permission of named) {
			expect(PANEL_PERMISSION_IDS, `the security page names "${permission}" and the panel has no such grant`).toContain(
				permission,
			);
		}
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
