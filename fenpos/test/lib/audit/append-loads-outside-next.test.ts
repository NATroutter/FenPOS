import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Proves `lib/audit/append.ts` and `lib/auth/recover.ts` are loadable from a plain node process, not
 * just from this suite.
 *
 * Being reachable outside Next is the entire reason both modules exist — `pnpm auth:recover` needs
 * them, and everything behind `import "server-only"` refuses that caller. But an ordinary
 * `import "@/lib/audit/append"` inside a vitest test cannot prove that: `vitest.config.mts` aliases
 * `server-only` to an empty stub so the rest of the suite can exercise server-gated modules at all,
 * which means an in-process import here would keep passing even if either module grew a
 * `server-only` dependency tomorrow — silently, since nothing else in the suite would notice.
 * `test/lib/audit/append.test.ts`'s fourth case even imports `audit-log.ts` in the same process,
 * which only works because of that same alias.
 *
 * So this spawns a real, unaliased `tsx` — the same runtime `pnpm auth:recover` will run under —
 * against a fixture that imports nothing but the two modules' exports, and lets the child process's
 * exit code report whether the import graph stayed clean. `test/setup-database.ts` shells out to a
 * real command the same way, for the same reason: some properties only hold up when checked by the
 * actual runtime rather than by a substitute vitest provides for convenience.
 */
/**
 * This one spec's own timeout, well past the suite-wide `testTimeout` of 10s in `vitest.config.mts`.
 *
 * Everything else in the suite runs in-process; this spawns `npx tsx`, which resolves a binary, boots
 * a second Node, and type-strips an import graph that reaches the generated Prisma client. On an
 * unloaded machine that costs about five seconds — comfortably inside the default — but the suite
 * runs its files in parallel, and under that contention the same spawn has been observed to pass the
 * ten-second mark and fail while passing in four seconds when re-run on its own.
 *
 * Raised rather than left to be re-run, because the failure mode is the damaging one: a guard that
 * goes red at random teaches whoever sees it to re-run rather than to read, which is precisely the
 * habit that would let this guard's *real* failure — a `server-only` import creeping into either
 * module and breaking `pnpm auth:recover` — be waved through as "the flaky one again". Deleting or
 * skipping it is not an option: it is the only check that either module still loads outside Next.
 */
const SPAWN_TIMEOUT_MS = 60_000;

describe("lib/audit/append.ts and lib/auth/recover.ts", () => {
	it(
		"import cleanly outside Next, with no server-only alias to hide behind",
		() => {
			const fixture = fileURLToPath(new URL("./fixtures/append-loads-outside-next.ts", import.meta.url));
			const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));

			expect(() => {
				execFileSync("npx", ["tsx", fixture], {
					cwd: projectRoot,
					stdio: "pipe",
					shell: process.platform === "win32",
				});
			}).not.toThrow();
		},
		SPAWN_TIMEOUT_MS,
	);
});
