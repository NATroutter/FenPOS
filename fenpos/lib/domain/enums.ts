import { z } from "zod";

/**
 * Closed value sets shared by the server, the admin panel, and the agent protocol.
 *
 * SQLite cannot express Prisma enums, so these columns are stored as TEXT. That makes this
 * module the only place where the permitted values are defined: a database row, an API
 * payload, and a WebSocket frame are all validated against the same tuples here. Widening a
 * set anywhere else would let an unrepresentable value reach a printer.
 *
 * Every set mirrors an enum in the Java agent under
 * `agent/src/main/java/fi/natroutter/fenpos/enums/`. The two must not drift: a value the
 * server accepts but the agent cannot parse becomes a job that fails after it was already
 * acknowledged. When changing a set here, change the Java enum in the same commit.
 */

/**
 * Builds the artefacts needed for one closed value set.
 *
 * Returns the tuple (for rendering choices in the panel), a Zod schema (for validating
 * anything crossing a trust boundary), and a type guard (for narrowing values read from the
 * database, which Prisma types as plain `string`).
 *
 * @param values the permitted values, which must match the corresponding Java enum
 * @returns the value tuple, its Zod schema, and a type guard over it
 */
function closedSet<const T extends readonly [string, ...string[]]>(values: T) {
	const schema = z.enum(values);
	return {
		values,
		schema,
		/**
		 * Narrows an arbitrary string to a member of this set.
		 *
		 * @param value the candidate, typically a column Prisma typed as `string`
		 * @returns whether the value belongs to the set
		 */
		is(value: string): value is T[number] {
			return (values as readonly string[]).includes(value);
		},
	} as const;
}

/** Whether a agent currently holds a live WebSocket. Observed state, never desired state. */
export const AgentStatus = closedSet(["PENDING", "ONLINE", "OFFLINE"] as const);
export type AgentStatus = (typeof AgentStatus.values)[number];

/** Mirrors `JobState` in the agent. Terminal states are COMPLETED, FAILED and CANCELLED. */
export const JobStatus = closedSet(["QUEUED", "PRINTING", "COMPLETED", "FAILED", "CANCELLED"] as const);
export type JobStatus = (typeof JobStatus.values)[number];

/**
 * Job states that can no longer change.
 *
 * Mirrors `JobState.isTerminal()` in the agent. Used to reject cancellation of work that has
 * already settled, and to decide when a job record stops being updated by agent reports.
 */
export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = ["COMPLETED", "FAILED", "CANCELLED"];

/**
 * Whether a job has reached a state that can no longer change.
 *
 * @param status the job status to test
 * @returns true when no further transition is possible
 */
export function isTerminalJobStatus(status: JobStatus): boolean {
	return TERMINAL_JOB_STATUSES.includes(status);
}

/** Mirrors `ConnectionStatus` in the agent. Only CONNECTED can accept work. */
export const ConnectionStatus = closedSet(["CONNECTED", "DISCONNECTED", "NO_DEVICE", "FAILED_TO_CONNECT"] as const);
export type ConnectionStatus = (typeof ConnectionStatus.values)[number];

/** Severity of an operational log line, for both server-raised and agent-forwarded entries. */
export const LogLevel = closedSet(["DEBUG", "INFO", "WARN", "ERROR"] as const);
export type LogLevel = (typeof LogLevel.values)[number];

/** Serial parity. Mirrors `Parity` in the agent, which maps each to a jSerialComm constant. */
export const Parity = closedSet(["NONE", "ODD", "EVEN", "MARK", "SPACE"] as const);
export type Parity = (typeof Parity.values)[number];

/**
 * Serial flow control. Mirrors `FlowControl` in the agent.
 *
 * Note these are the individual jSerialComm flags rather than the combined modes some
 * drivers present: RTS and CTS are separate values, as are the two XON/XOFF directions.
 */
export const FlowControl = closedSet(["NONE", "RTS", "CTS", "DSR", "DTR", "XONXOFF_IN", "XONXOFF_OUT"] as const);
export type FlowControl = (typeof FlowControl.values)[number];

/**
 * Printer codepages. Mirrors `Codepage` in the agent, which resolves each to a JVM charset.
 *
 * CP858 is the default because it is the only IBM table carrying both the euro sign and the
 * Nordic vowels, which is what Finnish receipts need.
 */
export const Codepage = closedSet([
	"CP437",
	"CP850",
	"CP852",
	"CP857",
	"CP858",
	"CP860",
	"CP863",
	"CP865",
	"CP866",
	"CP1250",
	"CP1251",
	"CP1252",
	"ISO8859_7",
] as const);
export type Codepage = (typeof Codepage.values)[number];

/** What to do with a character the target codepage cannot represent. */
export const UnsupportedPolicy = closedSet(["REJECT", "REPLACE", "STRIP"] as const);
export type UnsupportedPolicy = (typeof UnsupportedPolicy.values)[number];

/**
 * Line terminator written after each printed line. Mirrors `Linefeed` in the agent.
 *
 * NONE emits no bytes at all, for printers that advance the paper themselves.
 */
export const Linefeed = closedSet(["LF", "CRLF", "NONE"] as const);
export type Linefeed = (typeof Linefeed.values)[number];

/** Line justification. ESC/POS applies this per printed line, never per span. */
export const Align = closedSet(["LEFT", "CENTER", "RIGHT"] as const);
export type Align = (typeof Align.values)[number];

/** Printer font. B is narrower than A and fits more columns on the same paper. */
export const Font = closedSet(["A", "B"] as const);
export type Font = (typeof Font.values)[number];

/** Linear barcode symbologies. Mirrors BarcodeSystem in the agent. */
export const BarcodeSystem = closedSet([
	"UPCA",
	"UPCE",
	"EAN13",
	"EAN8",
	"CODE39",
	"ITF",
	"CODABAR",
	"CODE93",
	"CODE128",
] as const);
export type BarcodeSystem = (typeof BarcodeSystem.values)[number];

/**
 * What an asset is. One value today; a second is a new value and a new branch, not a new
 * table.
 *
 * Deliberately has no Java mirror, unlike every other set in this file: asset kinds never
 * cross the link to the agent, only the asset's bytes do. Do not add one.
 */
export const AssetKind = closedSet(["IMAGE"] as const);
export type AssetKind = (typeof AssetKind.values)[number];
