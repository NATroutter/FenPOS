/**
 * Startup dispatch.
 *
 * This module is compiled for every runtime Next targets, including edge. It therefore
 * contains nothing but the runtime check and a single dynamic import: the bundler traces
 * imports statically, so anything referenced here — even from inside a guarded function —
 * gets pulled into the edge bundle, where Prisma's `node:` built-ins do not exist and the
 * compile fails.
 *
 * All actual startup work lives in instrumentation-runtime.ts, which is only ever reached from
 * the Node.js runtime branch below.
 */
export async function register(): Promise<void> {
	if (process.env.NEXT_RUNTIME !== "nodejs") {
		return;
	}

	const { registerRuntime } = await import("./instrumentation-runtime");
	await registerRuntime();
}
