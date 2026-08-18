import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Vitest configuration for FenPOS.
 *
 * Tests run in a Node environment rather than jsdom: everything under test here is
 * server-side logic — credential handling, protocol framing, the markup pipeline — and a
 * simulated DOM would only slow the suite down. React component tests, if they are ever
 * needed, should get their own project entry rather than changing this default.
 */
export default defineConfig({
	resolve: {
		alias: {
			// `server-only` throws unless resolved under Next's bundler conditions, which
			// would make every guarded module untestable. The guard stays live in real
			// builds; only the test run substitutes an empty module.
			"server-only": fileURLToPath(new URL("./test/server-only-stub.ts", import.meta.url)),
			"@": fileURLToPath(new URL(".", import.meta.url)),
		},
	},
	test: {
		environment: "node",
		include: ["**/*.test.ts"],
		exclude: ["node_modules/**", ".next/**", "generated/**"],
		// Migrating the fixture database costs a few seconds on a cold run.
		hookTimeout: 60_000,
		testTimeout: 10_000,
		setupFiles: ["./test/setup-database.ts"],
	},
});
