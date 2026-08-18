import type { Server } from "node:http";

/**
 * The handoff of the HTTP server from the process entry point to the application.
 *
 * This exists because the two run in different module realms. `server.ts` is executed
 * directly by Agent, while everything under `lib/` is resolved by Next's bundler when
 * imported from `instrumentation.ts`. The same import specifier therefore yields two
 * separate module instances, so ordinary module-level state cannot carry a value between
 * them — `globalThis` is the only channel they genuinely share.
 *
 * The alternative was to give `server.ts` the ability to attach the link itself, which would
 * mean dropping the `server-only` guard from the database and credential modules so a plain
 * Agent process could import them. Keeping the guard and passing one object across is the
 * smaller compromise.
 */

/** Key under which the running server is published. Deliberately specific to this project. */
const HANDLE_KEY = "__fenposHttpServer";

type HandleHolder = { [HANDLE_KEY]?: Server };

/**
 * Publishes the running HTTP server so the application can attach to it.
 *
 * Called once by the process entry point, before Next is prepared, so the server is already
 * available when instrumentation runs.
 *
 * @param server the HTTP server this process is running
 */
export function publishHttpServer(server: Server): void {
	(globalThis as HandleHolder)[HANDLE_KEY] = server;
}

/**
 * Retrieves the running HTTP server.
 *
 * @returns the server, or undefined when the application is running under `next start`
 *          rather than the project's own entry point — in which case there is no server to
 *          attach a WebSocket to, and the caller must say so rather than assume one
 */
export function getHttpServer(): Server | undefined {
	return (globalThis as HandleHolder)[HANDLE_KEY];
}
