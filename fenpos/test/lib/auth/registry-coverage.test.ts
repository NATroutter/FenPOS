import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PANEL_ACTIONS, registryEntryFor } from "@/lib/auth/panel-actions";

/**
 * Nothing escapes the registry.
 *
 * This is the test the central registry was chosen for. A per-file helper could gate every action
 * just as well, right up until somebody adds the forty-first and does not; there would be nothing
 * to compare the filesystem against. This walks `app/`, finds every export of every `"use server"`
 * module, and fails when one is not accounted for — so forgetting to gate an action is a build
 * failure rather than something review has to catch.
 *
 * It also fails in the other direction, on a registry entry naming an export that no longer exists,
 * because a stale entry is a gate nothing goes through and a reader has no way to tell.
 */
const APP_ROOT = fileURLToPath(new URL("../../../app/", import.meta.url));

/** Every `.ts`/`.tsx` file under `app/`, as paths relative to it with forward slashes. */
function sourceFiles(directory: string): string[] {
	const found: string[] = [];
	for (const name of readdirSync(directory)) {
		const full = join(directory, name);
		if (statSync(full).isDirectory()) {
			found.push(...sourceFiles(full));
			continue;
		}
		if (name.endsWith(".ts") || name.endsWith(".tsx")) {
			found.push(relative(APP_ROOT, full).split(sep).join("/"));
		}
	}
	return found;
}

/**
 * Removes comments, so a `"use server"` written *about* server modules is not read as one.
 *
 * `app/(panel)/agents/action-state.ts` does exactly that, and without this it would be scanned as a
 * server module — which passes today only because it exports no functions, and would stop passing
 * the moment somebody added one.
 */
function withoutComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/** Whether a module carries a `"use server"` directive of its own, as its first statement. */
function isServerModule(source: string): boolean {
	return /^\s*["']use server["']/.test(withoutComments(source));
}

/** Whether a module declares a function that is itself a server action. */
function hasInlineAction(source: string): boolean {
	return /async\s+function\s+\w+\s*\([^)]*\)[^{]*\{\s*["']use server["']/.test(withoutComments(source));
}

/** The names of every `export async function`, plus any function with an inline `"use server"`. */
function exportedActions(source: string): string[] {
	const stripped = withoutComments(source);
	const exported = [...stripped.matchAll(/export\s+async\s+function\s+(\w+)/g)].map((match) => match[1]);
	// A layout's inline action is declared, not exported: `async function signOut() { "use server" }`.
	const inline = [...stripped.matchAll(/async\s+function\s+(\w+)\s*\([^)]*\)[^{]*\{\s*["']use server["']/g)].map(
		(match) => match[1],
	);
	return [...new Set([...exported, ...inline])];
}

describe("panel action coverage", () => {
	it("finds the server modules it expects to find", () => {
		// A guard on the walker itself: a scan that silently matched nothing would pass every
		// assertion below while proving nothing at all.
		const modules = sourceFiles(APP_ROOT).filter((file) => isServerModule(readFileSync(join(APP_ROOT, file), "utf8")));

		expect(modules.length).toBeGreaterThanOrEqual(8);
		expect(modules).toContain("(panel)/agents/actions.ts");
	});

	it("does not mistake a comment about `use server` for the directive", () => {
		// `action-state.ts` explains why a `"use server"` module may only export async functions. It
		// is not one, and reading it as one is the trap this scan has to avoid.
		const source = readFileSync(join(APP_ROOT, "(panel)/agents/action-state.ts"), "utf8");

		expect(source).toContain("use server");
		expect(isServerModule(source)).toBe(false);
	});

	it("has a registry entry for every server action under app/", () => {
		const missing: string[] = [];

		for (const file of sourceFiles(APP_ROOT)) {
			const source = readFileSync(join(APP_ROOT, file), "utf8");
			if (!isServerModule(source) && !hasInlineAction(source)) {
				continue;
			}
			for (const exportName of exportedActions(source)) {
				if (!registryEntryFor(file, exportName)) {
					missing.push(`${file}#${exportName}`);
				}
			}
		}

		// Add the action to `lib/auth/panel-actions.ts` and gate it. If it genuinely needs no
		// permission, register it as `self` or `unauthenticated` and say why — the point is that
		// ungated is a decision somebody wrote down, not an omission.
		expect(missing).toEqual([]);
	});

	it("has no registry entry pointing at an export that no longer exists", () => {
		const stale = PANEL_ACTIONS.filter((entry) => {
			const source = readFileSync(join(APP_ROOT, entry.module), "utf8");
			return !exportedActions(source).includes(entry.exportName);
		}).map((entry) => `${entry.module}#${entry.exportName}`);

		expect(stale).toEqual([]);
	});
});
