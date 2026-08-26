import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Proves `lib/audit/append.ts` is loadable from a plain node process, not just from this suite.
 *
 * Being reachable outside Next is the entire reason `append.ts` exists — `pnpm auth:recover` needs
 * it, and everything behind `import "server-only"` refuses that caller. But an ordinary
 * `import "@/lib/audit/append"` inside a vitest test cannot prove that: `vitest.config.mts` aliases
 * `server-only` to an empty stub so the rest of the suite can exercise server-gated modules at all,
 * which means an in-process import here would keep passing even if `append.ts` grew a `server-only`
 * dependency tomorrow — silently, since nothing else in the suite would notice. `test/lib/audit/
 * append.test.ts`'s fourth case even imports `audit-log.ts` in the same process, which only works
 * because of that same alias.
 *
 * So this spawns a real, unaliased `tsx` — the same runtime `pnpm auth:recover` will run under —
 * against a fixture that imports nothing but `appendAuditEvent`, and lets the child process's exit
 * code report whether the import graph stayed clean. `test/setup-database.ts` shells out to a real
 * command the same way, for the same reason: some properties only hold up when checked by the actual
 * runtime rather than by a substitute vitest provides for convenience.
 */
describe("lib/audit/append.ts", () => {
	it("imports cleanly outside Next, with no server-only alias to hide behind", () => {
		const fixture = fileURLToPath(new URL("./fixtures/append-loads-outside-next.ts", import.meta.url));
		const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));

		expect(() => {
			execFileSync("npx", ["tsx", fixture], {
				cwd: projectRoot,
				stdio: "pipe",
				shell: process.platform === "win32",
			});
		}).not.toThrow();
	});
});
