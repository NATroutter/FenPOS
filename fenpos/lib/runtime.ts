import "server-only";
import { version } from "@/package.json";

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
 * Read from package.json, which is the one place a release actually bumps. It used to come from
 * an `APP_VERSION` environment variable with a hardcoded fallback, so that a container image
 * could stamp its own build — but nothing ever set the variable, and the fallback was what the
 * panel showed. A second source of truth that no deployment writes to is not a second source of
 * truth; it is a copy that drifts, and it had.
 */
export const APP_VERSION: string = version;
