import "server-only";
import type { LogLevel } from "@/lib/domain/enums";
import { isProduction } from "@/lib/env";
import { redact } from "@/lib/redact";

/**
 * Structured process logging for the server.
 *
 * Writes to stdout only. Persisting operational log lines for the panel's Logs tab is a
 * separate concern with its own service, because a logger that writes to the database
 * cannot report a database failure without recursing into the failure it is reporting.
 *
 * Levels match `LogLevel` in the domain module and the agent's own logger, so a line raised
 * on either side of the link reads the same way.
 */

/** Structured fields attached to a log line. Values must already be safe to record. */
export type LogContext = Record<string, unknown>;

const LEVEL_PRIORITY: Record<LogLevel, number> = {
	DEBUG: 10,
	INFO: 20,
	WARN: 30,
	ERROR: 40,
};

/**
 * This module's own default: quiet in production, loud everywhere else.
 *
 * Named rather than inlined so {@link resetMinimumLevel} restores exactly this value instead of
 * recomputing an expression that would have to stay in sync with the one below.
 */
const BUILT_IN_MINIMUM_LEVEL: LogLevel = isProduction ? "INFO" : "DEBUG";

/**
 * Below this level, lines are dropped.
 *
 * Mutable, and pushed in by the settings store rather than read from it. `write` is synchronous and
 * runs on every line, so it cannot await a database read; and `settings-service.ts` imports this
 * module, so reading the store from here would be a cycle. The store calls `setMinimumLevel` or
 * `resetMinimumLevel` instead — at startup and after every save or reset.
 *
 * Starts at {@link BUILT_IN_MINIMUM_LEVEL}. A caller that never reaches startup — a unit test, an
 * edge runtime — keeps that value forever, since nothing there ever calls `setMinimumLevel` or
 * `resetMinimumLevel`. **The dev server is not such a caller**: `applyPushedSettings`
 * (`settings-service.ts`) runs at every startup there too, and calls `resetMinimumLevel` whenever
 * `logs.minimumLevel` is not overridden — which reinstates this same value rather than skipping the
 * push. A fresh install's dev server logs at DEBUG not because startup left it alone, but because
 * startup explicitly puts it back.
 */
let minimumLevel: LogLevel = BUILT_IN_MINIMUM_LEVEL;

/**
 * Sets the level below which lines are dropped.
 *
 * @param level the lowest severity to write
 */
export function setMinimumLevel(level: LogLevel): void {
	minimumLevel = level;
}

/**
 * Restores {@link BUILT_IN_MINIMUM_LEVEL}, undoing whatever `setMinimumLevel` last pushed.
 *
 * Exists because "no stored override" and "do nothing" are not the same instruction: the settings
 * store must be able to put this module back to what it started at, the same way clearing any
 * other setting returns it to its declared fallback — see `applyPushedSettings`.
 */
export function resetMinimumLevel(): void {
	minimumLevel = BUILT_IN_MINIMUM_LEVEL;
}

/**
 * Reduces an unknown thrown value to something loggable.
 *
 * Errors reach here from `catch` blocks, where TypeScript types them as `unknown`. The
 * cause chain is preserved because the underlying failure is usually the interesting one.
 *
 * @param error the caught value
 * @returns a plain object describing the failure
 */
function describeError(error: unknown): Record<string, unknown> {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			stack: error.stack,
			...(error.cause === undefined ? {} : { cause: describeError(error.cause) }),
		};
	}
	return { message: String(error) };
}

/**
 * Writes one line at the given level.
 *
 * Production emits one JSON object per line so a log shipper can parse it; development
 * emits a compact human-readable form, because a developer reading a terminal is the
 * consumer there.
 *
 * @param level severity of the line
 * @param message short human-readable summary
 * @param context structured fields; sensitive keys are redacted before writing
 */
function write(level: LogLevel, message: string, context?: LogContext): void {
	if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[minimumLevel]) {
		return;
	}

	const safeContext = context ? (redact(context) as LogContext) : undefined;
	const timestamp = new Date().toISOString();

	// process.stdout is used directly rather than console.* so that log output is one
	// deliberate channel, and an accidental console.log elsewhere stays visibly different.
	if (isProduction) {
		process.stdout.write(`${JSON.stringify({ timestamp, level, message, ...safeContext })}\n`);
		return;
	}

	const suffix = safeContext && Object.keys(safeContext).length > 0 ? ` ${JSON.stringify(safeContext)}` : "";
	process.stdout.write(`${timestamp} ${level.padEnd(5)} ${message}${suffix}\n`);
}

/**
 * The server logger.
 *
 * Use this rather than `console.*`. Temporary debugging output must not survive into a
 * commit; `logger.debug` is the supported way to keep something noisy but intentional.
 */
export const logger = {
	/** Detail useful while developing. Suppressed in production. */
	debug(message: string, context?: LogContext): void {
		write("DEBUG", message, context);
	},

	/** Normal lifecycle events: startup, pairing, agent connect and disconnect. */
	info(message: string, context?: LogContext): void {
		write("INFO", message, context);
	},

	/** Something recoverable that an operator would want to know about. */
	warn(message: string, context?: LogContext): void {
		write("WARN", message, context);
	},

	/**
	 * A failure. Pass the caught value as `error` so its message, stack, and cause chain are
	 * recorded rather than a bare string.
	 */
	error(message: string, error?: unknown, context?: LogContext): void {
		write("ERROR", message, {
			...context,
			...(error === undefined ? {} : { error: describeError(error) }),
		});
	},
} as const;
