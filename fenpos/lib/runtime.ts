import "server-only";

/**
 * Facts about this running process.
 */

/**
 * When this process started, as epoch milliseconds.
 *
 * Captured at module load rather than read from `process.uptime()` on demand, so every
 * consumer sees one consistent origin and the value can be handed to the client to count
 * from.
 */
export const SERVER_STARTED_AT: number = Date.now();

/**
 * Application version, shown in the panel.
 *
 * Sourced from the environment so a container image can stamp its own build without the
 * value drifting from package.json at runtime; falls back to a clear placeholder rather than
 * a plausible-looking number, because a wrong version in a bug report costs more than an
 * obviously absent one.
 */
export const APP_VERSION: string = process.env.APP_VERSION ?? "0.1.0-dev";
