import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { IMAGE_LIMITS, JOB_LIMITS, MAX_FRAME_BYTES } from "@/lib/link/protocol";

/**
 * The agent restates every bound on this protocol, because a receiver that trusts the sender's
 * range checks has not validated anything. Restating them means they can drift, and drift here
 * is not a failed build: it is a job this server accepts and the agent then refuses, or worse,
 * one the agent accepts and should not have.
 *
 * This is a monorepo, so the Java file is right there to read. Reading it is cruder than
 * generating both sides from one description, and much cheaper: the numbers are few, they change
 * rarely, and a mismatch here names exactly which one moved.
 */
const CODEC = join(__dirname, "../../../../agent/src/main/java/fi/natroutter/fenpos/link/FrameCodec.java");

/**
 * Reads `static final int NAME = ...;` from the agent's codec, public or private. The right-hand
 * side is a literal, a multiplication of two literals, or a subtraction naming another constant
 * declared the same way, which covers every shape a bound takes there, including one derived from
 * another bound.
 */
function agentBound(name: string): number {
	const source = readFileSync(CODEC, "utf8");
	const declaration = source.match(new RegExp(`(?:public|private) static final int ${name}\\s*=\\s*([^;]+);`));
	if (!declaration) {
		throw new Error(`${name} is not declared in FrameCodec.java, or its declaration changed shape`);
	}
	return resolveExpression(declaration[1].trim());
}

function resolveExpression(expression: string): number {
	const operation = expression.match(/^(.+?)\s*([-*])\s*(.+)$/);
	if (!operation) {
		return resolveOperand(expression);
	}
	const [, left, operator, right] = operation;
	const a = resolveOperand(left.trim());
	const b = resolveOperand(right.trim());
	return operator === "-" ? a - b : a * b;
}

function resolveOperand(token: string): number {
	if (/^[0-9_]+$/.test(token)) {
		return Number(token.replace(/_/g, ""));
	}
	return agentBound(token);
}

describe("the agent's bounds match this protocol", () => {
	it.each([
		["MAX_FRAME_BYTES", MAX_FRAME_BYTES],
		["MAX_LINES", JOB_LIMITS.maxLines],
		["MAX_SPANS_PER_LINE", JOB_LIMITS.maxSpansPerLine],
		["MAX_SPAN_CHARS", JOB_LIMITS.maxSpanChars],
		["MAX_DIRECTIVES_PER_LINE", JOB_LIMITS.maxDirectivesPerLine],
		["MAX_RASTER_CHARS", IMAGE_LIMITS.maxRasterChars],
		["MAX_SYNCED_RASTERS", IMAGE_LIMITS.maxSyncedRasters],
		["MAX_RASTER_WIDTH_DOTS", IMAGE_LIMITS.maxWidthDots],
		["MAX_RASTER_HEIGHT_DOTS", IMAGE_LIMITS.maxHeightDots],
		["MAX_DEVICES", 256],
		["MAX_RAW_CHARS", 16_384],
		["MAX_ID_CHARS", 64],
		["MAX_PORT_CHARS", 256],
		["MAX_AGENT_NAME_CHARS", 128],
		["MAX_QR_CHARS", 4_296],
		["MAX_PDF417_CHARS", 1_850],
		["MAX_BARCODE_CHARS", 255],
		["MAX_CODE128_CHARS", 253],
	])("%s", (name, expected) => {
		expect(agentBound(name)).toBe(expected);
	});
});
