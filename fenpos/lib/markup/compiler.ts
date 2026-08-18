import type { Codepage, Linefeed, UnsupportedPolicy } from "@/lib/domain/enums";
import { ApiError } from "@/lib/errors";
import type { CompiledJob, Directive as WireDirective, Line as WireLine, Span as WireSpan } from "@/lib/link/protocol";
import { validateCharset } from "@/lib/markup/charset";
import { MarkupError, UnsupportedCharacterError } from "@/lib/markup/errors";
import { isDirectiveOnly, type Line } from "@/lib/markup/model";
import { parseMarkup } from "@/lib/markup/parser";
import { wrapLine } from "@/lib/markup/wrapper";

/**
 * Turns a request body into a job an agent can print, or explains precisely why it cannot.
 *
 * **Every stage runs synchronously, before the request is answered.** That is the property the
 * whole API is built around: once a job is accepted it can only fail for hardware reasons, and
 * every content problem has already been reported to the caller with the line and column that
 * caused it. A `400` naming the exact character a codepage cannot represent is worth far more
 * than a job that is accepted and then quietly fails somewhere behind a printer.
 *
 * Stages are ordered cheapest-first. Limits are enforced before any element is parsed, so an
 * oversized request is refused without doing the work it was trying to provoke.
 *
 * Ported from `PrintCompiler.java`, whose tests are the specification. The one difference is the
 * output: the Java version rendered ESC/POS bytes because it owned the printer, while this stops
 * at the intermediate representation and lets the agent emit the bytes.
 */

/** The rendering character for a horizontal rule. */
const RULE_CHARACTER = "-";

/** Limits applied to one request. */
export interface CompileLimits {
	maxLines: number;
	maxLineChars: number;
	maxTotalChars: number;
	maxOutputLines: number;
}

/** Print settings the compiler needs, as configured on the device. */
export interface CompileSettings {
	columns: number;
	codepage: Codepage;
	onUnsupported: UnsupportedPolicy;
	defaultWrap: boolean;
	defaultLinefeed: Linefeed;
}

/** What a caller asked to print, after the request body has been read. */
export interface PrintRequest {
	data: string[];
	wrap: boolean;
	linefeed: Linefeed;
}

/**
 * Reads and limit-checks a request body.
 *
 * Lengths are measured on the raw strings, before markup is interpreted, so the totals a client
 * computes match the totals enforced here.
 *
 * @param body the parsed JSON body
 * @param limits the limits to apply
 * @param settings the device's print settings, supplying defaults
 * @returns the request, validated
 * @throws ApiError when the body is malformed or exceeds a limit
 */
export function readRequest(body: unknown, limits: CompileLimits, settings: CompileSettings): PrintRequest {
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		throw new ApiError("invalid_json", "Body must be a JSON object");
	}

	const record = body as Record<string, unknown>;

	const data = record.data;
	if (data === undefined || data === null) {
		throw new ApiError("missing_field", "'data' is required");
	}
	if (!Array.isArray(data)) {
		throw new ApiError("invalid_type", "'data' must be an array of strings");
	}
	if (data.length > limits.maxLines) {
		throw new ApiError("too_many_lines", `At most ${limits.maxLines} lines are allowed, got ${data.length}`);
	}

	const elements: string[] = [];
	let total = 0;
	for (let index = 0; index < data.length; index++) {
		const line = index + 1;
		const element = data[index];

		if (typeof element !== "string") {
			throw new ApiError("invalid_type", "Every element of 'data' must be a string", { line });
		}
		if (element.length > limits.maxLineChars) {
			throw new ApiError(
				"line_too_long",
				`At most ${limits.maxLineChars} characters are allowed per line, got ${element.length}`,
				{ line },
			);
		}

		total += element.length;
		if (total > limits.maxTotalChars) {
			throw new ApiError("text_too_large", `At most ${limits.maxTotalChars} characters are allowed in total`, { line });
		}
		elements.push(element);
	}

	return {
		data: elements,
		wrap: readWrap(record.wrap, settings),
		linefeed: readLinefeed(record.linefeed, settings),
	};
}

function readWrap(value: unknown, settings: CompileSettings): boolean {
	if (value === undefined || value === null) {
		return settings.defaultWrap;
	}
	if (typeof value !== "boolean") {
		throw new ApiError("invalid_type", "'wrap' must be true or false");
	}
	return value;
}

function readLinefeed(value: unknown, settings: CompileSettings): Linefeed {
	if (value === undefined || value === null) {
		return settings.defaultLinefeed;
	}
	if (typeof value !== "string") {
		throw new ApiError("invalid_type", "'linefeed' must be a string");
	}
	const upper = value.toUpperCase();
	if (upper !== "LF" && upper !== "CRLF" && upper !== "NONE") {
		throw new ApiError("invalid_linefeed", `Unknown linefeed '${value}'; must be one of: LF, CRLF, NONE`);
	}
	return upper;
}

/**
 * Compiles a validated request into a job for one device.
 *
 * @param jobId the identifier both sides will use for this job
 * @param deviceName the device the job prints on
 * @param request what to print
 * @param limits the limits to apply after wrapping
 * @param settings the device's print settings
 * @returns the compiled job
 * @throws ApiError when an element is malformed or the output exceeds a limit
 */
export function compile(
	jobId: string,
	deviceName: string,
	request: PrintRequest,
	limits: CompileLimits,
	settings: CompileSettings,
): CompiledJob {
	const lines = layOut(request, settings);
	requireOutputWithinLimit(lines, limits);

	return {
		jobId,
		device: deviceName,
		linefeed: request.linefeed,
		lines: lines.map((line) => toWireLine(line, settings.columns)),
	};
}

/**
 * Parses, validates and wraps each element.
 *
 * Positional failures raised by the parser and the charset check are translated into
 * request-level errors carrying the element index, so a caller can point at the exact element as
 * well as the exact character.
 */
function layOut(request: PrintRequest, settings: CompileSettings): Line[] {
	const lines: Line[] = [];

	for (let index = 0; index < request.data.length; index++) {
		const lineNumber = index + 1;
		try {
			const parsed = parseMarkup(request.data[index]);
			const checked = validateCharset(parsed, settings.codepage, settings.onUnsupported);
			if (request.wrap) {
				lines.push(...wrapLine(checked, settings.columns));
			} else {
				lines.push(checked);
			}
		} catch (error) {
			throw translate(error, lineNumber);
		}
	}

	return lines;
}

/** Turns a positional failure into the API error that reports it. */
function translate(error: unknown, line: number): unknown {
	if (error instanceof MarkupError) {
		return new ApiError(error.code, error.message, {
			line,
			column: error.column,
			...(error.detail === null ? {} : { detail: error.detail }),
		});
	}
	if (error instanceof UnsupportedCharacterError) {
		return new ApiError("unsupported_character", error.message, {
			line,
			column: error.column,
			character: error.character,
			codepage: error.codepage,
		});
	}
	return error;
}

function requireOutputWithinLimit(lines: Line[], limits: CompileLimits): void {
	const printed = countTextLines(lines);
	if (printed > limits.maxOutputLines) {
		throw new ApiError(
			"too_many_output_lines",
			`Wrapping produced ${printed} lines, more than the limit of ${limits.maxOutputLines}`,
		);
	}
}

/** Counts lines that advance the paper; directive-only lines do not. */
export function countTextLines(lines: Line[]): number {
	return lines.filter((line) => !isDirectiveOnly(line)).length;
}

/**
 * Converts one parsed line to its wire shape, expanding any rule.
 *
 * The rule is expanded here rather than on the agent because only the server knows the device's
 * column count at compile time. What crosses the link is therefore always text, and the agent
 * never has to know what a rule is.
 */
function toWireLine(line: Line, columns: number): WireLine {
	const rule = line.directives.find((directive) => directive.kind === "RULE");

	const spans: WireSpan[] = rule
		? [
				{
					text: RULE_CHARACTER.repeat(columns),
					bold: false,
					underline: 0,
					invert: false,
					widthMult: 1,
					heightMult: 1,
					font: "A",
				},
			]
		: line.spans.map((span) => ({
				text: span.text,
				bold: span.style.bold,
				underline: span.style.underline,
				invert: span.style.invert,
				widthMult: span.style.widthMult,
				heightMult: span.style.heightMult,
				font: span.style.font,
			}));

	const directives: WireDirective[] = [];
	for (const directive of line.directives) {
		if (directive.kind === "CUT") {
			directives.push({ type: "CUT", mode: directive.mode });
		} else if (directive.kind === "FEED") {
			directives.push({ type: "FEED", lines: directive.lines });
		}
	}

	return { align: line.align, spans, directives };
}
