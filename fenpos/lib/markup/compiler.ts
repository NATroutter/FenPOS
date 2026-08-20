import type { Codepage, Linefeed, UnsupportedPolicy } from "@/lib/domain/enums";
import { ApiError } from "@/lib/errors";
import type { CompiledJob, Directive as WireDirective, Line as WireLine, Span as WireSpan } from "@/lib/link/protocol";
import { dotWidth } from "@/lib/markup/blocks";
import { validateCharset } from "@/lib/markup/charset";
import { MarkupError, UnsupportedCharacterError } from "@/lib/markup/errors";
import { type ImageSource, imageGeometry, type ResolvedImages } from "@/lib/markup/images";
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
 * One thing a request may need cannot be had synchronously: how large an image is. That is why
 * `resolveImages` runs before {@link compile} rather than inside it, and its answers arrive through
 * {@link CompileSettings}. Everything here stays a pure function of what it is handed, which is
 * what lets the preview and the print path share it without either waiting on the other.
 *
 * Ported from `PrintCompiler.java`, whose tests are the specification. The one difference is the
 * output: the Java version rendered ESC/POS bytes because it owned the printer, while this stops
 * at the intermediate representation and lets the agent emit the bytes.
 */

/** The rendering character for a horizontal rule. */
const RULE_CHARACTER = "-";

/**
 * The only keys a request body may carry.
 *
 * Checked rather than ignored because the field this replaced, `wrap`, changed behaviour when
 * it was removed: a caller still sending it would have got silently wrapped output and no way
 * to find out why. The same strictness catches every other typo that used to be swallowed.
 */
const ALLOWED_FIELDS = new Set(["data", "linefeed"]);

/** Limits applied to one request. */
export interface CompileLimits {
	maxLines: number;
	maxLineChars: number;
	maxTotalChars: number;
	maxOutputLines: number;
}

/** Print settings the compiler needs, as configured on the device. */
export interface DeviceSettings {
	columns: number;
	codepage: Codepage;
	onUnsupported: UnsupportedPolicy;
	defaultWrap: boolean;
	defaultLinefeed: Linefeed;
}

/**
 * Everything a compile needs: the device's own settings, plus what could only be found out
 * asynchronously.
 *
 * `images` is the second kind and the only member of it. An image's printed height depends on the
 * image's own dimensions, which are a database row for a stored asset and an HTTP response for a
 * URL — so they cannot be reached from inside a synchronous compile, and making `compile` async
 * would push `await` into every caller for the sake of one directive. Instead `resolveImages` runs
 * once before compiling and its result arrives here.
 *
 * Required rather than optional deliberately. An absent map would compile a receipt whose images
 * cost nothing, which is a job accepted against a budget it was never measured for; a required
 * field makes every caller state what it resolved, and `new Map()` is how a caller says "none".
 */
export interface CompileSettings extends DeviceSettings {
	images: ResolvedImages;
}

/** What a caller asked to print, after the request body has been read. */
export interface PrintRequest {
	data: string[];
	linefeed: Linefeed;
}

/**
 * Reads and limit-checks a request body.
 *
 * Lengths are measured on the raw strings, before markup is interpreted, so the totals a client
 * computes match the totals enforced here.
 *
 * Takes the device's settings rather than the whole {@link CompileSettings}, because it runs before
 * the images are resolved: what a request refers to cannot be known until its markup has been read,
 * and reading it is what this does.
 *
 * @param body the parsed JSON body
 * @param limits the limits to apply
 * @param settings the device's print settings, supplying defaults
 * @returns the request, validated
 * @throws ApiError when the body is malformed or exceeds a limit
 */
export function readRequest(body: unknown, limits: CompileLimits, settings: DeviceSettings): PrintRequest {
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		throw new ApiError("invalid_json", "Body must be a JSON object");
	}

	const record = body as Record<string, unknown>;

	for (const key of Object.keys(record)) {
		if (!ALLOWED_FIELDS.has(key)) {
			throw new ApiError(
				"unknown_field",
				key === "wrap"
					? "'wrap' is no longer a request field. Use the <wrap> and <nowrap> tags, which apply to one line."
					: `Unknown field '${key}'; this request accepts 'data' and 'linefeed'`,
			);
		}
	}

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
		linefeed: readLinefeed(record.linefeed, settings),
	};
}

function readLinefeed(value: unknown, settings: DeviceSettings): Linefeed {
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
	requireOutputWithinLimit(lines, limits, settings);

	return {
		jobId,
		device: deviceName,
		linefeed: request.linefeed,
		lines: lines.map((line) => toWireLine(line, settings)),
	};
}

/**
 * Parses, validates and wraps each element.
 *
 * Positional failures raised by the parser and the charset check are translated into
 * request-level errors carrying the element index, so a caller can point at the exact element as
 * well as the exact character.
 *
 * Exported for the paper preview, which needs a symbol's measured `heightLines` to draw it at the
 * height it was charged. That figure is deliberately absent from the wire — see {@link toWireLine}
 * — so the preview reads the lines at this stage instead. {@link compile} maps these lines to the
 * wire one for one and in order, so the two can be read side by side.
 *
 * @param request the validated request
 * @param settings the device's compile settings
 * @returns one line per line of paper, before the rule is expanded and the symbols leave for the
 *          agent
 * @throws ApiError when an element is malformed
 */
export function layOut(request: PrintRequest, settings: CompileSettings): Line[] {
	const lines: Line[] = [];

	for (let index = 0; index < request.data.length; index++) {
		const lineNumber = index + 1;
		try {
			const parsed = parseMarkup(request.data[index]);
			const checked = validateCharset(parsed, settings.codepage, settings.onUnsupported);
			const wrap = checked.wrap ?? settings.defaultWrap;
			if (wrap) {
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

/**
 * How many lines a request will advance the paper by.
 *
 * The same figure {@link compile} checks against `maxOutputLines`, from the same lay-out, so a
 * preview stating "24 of 300" cannot disagree with the limit that would reject it. It is measured
 * before the lines reach the wire because a rule is a directive at that point and becomes a line
 * of dashes only on the way out — counting after that conversion would report a number the limit
 * never applied.
 *
 * Costs a second lay-out. That is the preview's problem alone, and the preview is debounced.
 *
 * @param request the validated request
 * @param settings the device's compile settings
 * @returns the number of lines that advance the paper
 */
export function countOutputLines(request: PrintRequest, settings: CompileSettings): number {
	return countTextLines(layOut(request, settings), settings);
}

/**
 * Collects everything wrong with a request's elements, instead of stopping at the first.
 *
 * {@link compile} stops at the first failure, and is right to: a request either prints or it does
 * not, and doing more work on a body that is already a `400` buys nothing. The preview is read by
 * someone in the middle of fixing the markup, and handing them one mistake per round trip makes
 * four mistakes take four times as long to find.
 *
 * Only per-element failures are collected — parsing and the codepage check. Limits that apply to
 * the request as a whole are checked before this and after it, because "the whole thing is too
 * long" is not a mistake attributable to any one line.
 *
 * Takes the device's settings rather than the whole {@link CompileSettings} so that it can run
 * *before* the images are resolved, which is what it is worth: markup with an unclosed tag has no
 * business making this server fetch a URL, and the person fixing it should not wait for one either.
 *
 * @param request the validated request
 * @param settings the device's print settings
 * @returns every element error, in element order; empty when the markup is sound
 */
export function collectElementErrors(request: PrintRequest, settings: DeviceSettings): ApiError[] {
	const errors: ApiError[] = [];

	for (let index = 0; index < request.data.length; index++) {
		try {
			validateCharset(parseMarkup(request.data[index]), settings.codepage, settings.onUnsupported);
		} catch (error) {
			const translated = translate(error, index + 1);
			if (!(translated instanceof ApiError)) {
				// Not a markup failure at all, so not something to collect and carry on from.
				throw translated;
			}
			errors.push(translated);
		}
	}

	return errors;
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

function requireOutputWithinLimit(lines: Line[], limits: CompileLimits, settings: CompileSettings): void {
	const printed = countTextLines(lines, settings);
	if (printed > limits.maxOutputLines) {
		throw new ApiError(
			"too_many_output_lines",
			`Wrapping produced ${printed} lines, more than the limit of ${limits.maxOutputLines}`,
		);
	}
}

/**
 * Counts lines that advance the paper.
 *
 * Most directive-only lines advance nothing — see {@link isDirectiveOnly} — but two kinds of
 * directive are exceptions. A `RULE` has no spans of its own, yet `toWireLine` expands it into a
 * full line of dashes that really prints, so it costs one line here even though it looks empty at
 * this stage. A `QR`, `BARCODE` or `PDF417` costs its measured `heightLines` instead of the usual
 * one, because a symbol is a block of dots several lines tall rather than a single printed line.
 * That height is never recomputed here — it travels on the directive from {@link symbolGeometry},
 * which is also what the paper preview draws, so the two cannot disagree. `CUT`, `FEED` and
 * `DRAWER` still cost nothing: a cut and a feed act on the printer rather than laying dots on the
 * paper as text, and a drawer pulse is electrical and never touches the paper at all.
 *
 * An `IMAGE` costs its height too, but is the one directive whose height is worked out here rather
 * than carried: it depends on the paper's width and on the image's own dimensions, which the parser
 * has no way to reach. Both are in `settings` by the time this runs — see {@link CompileSettings}.
 *
 * @param lines the laid-out lines
 * @param settings the device's compile settings, holding the paper width and the resolved images
 * @returns the number of lines that advance the paper
 */
export function countTextLines(lines: Line[], settings: CompileSettings): number {
	return lines.reduce((total, line) => total + lineCost(line, settings), 0);
}

/** The paper cost of one line, in whole printed lines. */
function lineCost(line: Line, settings: CompileSettings): number {
	let blockHeight = 0;
	let hasRule = false;
	for (const directive of line.directives) {
		if (directive.kind === "QR" || directive.kind === "BARCODE" || directive.kind === "PDF417") {
			blockHeight += directive.heightLines;
		} else if (directive.kind === "IMAGE") {
			blockHeight += imageGeometry(
				resolved(directive.ref, settings),
				directive.widthPercent,
				settings.columns,
			).heightLines;
		} else if (directive.kind === "RULE") {
			hasRule = true;
		}
	}
	if (blockHeight > 0) {
		return blockHeight;
	}
	if (hasRule) {
		return 1;
	}
	return isDirectiveOnly(line) ? 0 : 1;
}

/**
 * Looks up what an image reference resolved to.
 *
 * A missing entry is a fault on this side rather than a bad request. The pre-pass sees every
 * reference this compile will meet — it reads the same elements with the same parser — and refuses
 * the whole job, by name, for one it cannot resolve. So arriving here without an entry means the
 * pre-pass was skipped, and the alternative to failing is a receipt whose images were never charged
 * against the budget that was supposed to bound it.
 *
 * @param ref the reference as written between the tags
 * @param settings the compile settings, carrying what the pre-pass resolved
 * @returns the image's own dimensions
 * @throws Error if the reference was never resolved
 */
function resolved(ref: string, settings: CompileSettings): ImageSource {
	const source = settings.images.get(ref);
	if (!source) {
		throw new Error(`The image '${ref}' was not resolved before compiling; resolveImages must run first`);
	}
	return source;
}

/**
 * Converts one parsed line to its wire shape, expanding any rule.
 *
 * The rule is expanded here rather than on the agent because only the server knows the device's
 * column count at compile time. What crosses the link is therefore always text, and the agent
 * never has to know what a rule is.
 *
 * `QR`, `BARCODE`, `PDF417` and `DRAWER` directives cross unchanged, unlike `RULE`: the agent's
 * ESC/POS library draws a symbol itself and computes its own geometry when it does, so this only
 * has to carry the content across. `heightLines` does not travel with them — it is a compile-time
 * budgeting value with no wire field, kept off the wire so the model and wire types stay the
 * distinct shapes {@link WireDirective}'s module documents.
 *
 * PDF417's `columns` is the one measured figure that does travel, because the printer's default is
 * to choose its own layout and a symbol laid out differently is a different number of rows from the
 * one charged. See the note on `directiveSchema` in `lib/link/protocol.ts`.
 *
 * `IMAGE` crosses by one of two routes, and which one is settled here — see {@link toWireImage}.
 */
function toWireLine(line: Line, settings: CompileSettings): WireLine {
	const columns = settings.columns;
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
		} else if (directive.kind === "QR") {
			directives.push({ type: "QR", content: directive.content, size: directive.size });
		} else if (directive.kind === "BARCODE") {
			directives.push({ type: "BARCODE", system: directive.system, content: directive.content });
		} else if (directive.kind === "PDF417") {
			directives.push({
				type: "PDF417",
				content: directive.content,
				errorLevel: directive.errorLevel,
				columns: directive.columns,
			});
		} else if (directive.kind === "DRAWER") {
			directives.push({ type: "DRAWER", pin: directive.pin });
		} else if (directive.kind === "IMAGE") {
			directives.push(toWireImage(directive.ref, directive.widthPercent, settings));
		}
	}

	return { align: line.align, spans, directives };
}

/**
 * Chooses how an image's dots reach the agent, and says so on the wire.
 *
 * **Naming beats sending.** A stored asset was dithered once, at each of the agent's paper widths,
 * and pushed with its configuration; a job printing it at that width need only say which one, so
 * the dots cross the link once per change rather than once per receipt. Everything else carries its
 * dots: a URL, because nothing could have pre-synced them, and a stored asset at some other printed
 * width, because the alternative — shrinking a raster on the agent — resamples dots that have
 * already been reduced to black and white and turns a logo into mud.
 *
 * The pre-pass is what makes those two cases one rule here: it produced a raster for exactly the
 * widths that must travel, so their presence is the answer. The paper width is checked as well, and
 * is the reason this can throw. A reference for a width the agent was never synced at would compile
 * cleanly and then fail behind a printer, which is the class of failure this pipeline exists to
 * prevent, so a pre-pass that produced the wrong set fails here instead.
 *
 * @param ref the reference as written between the tags
 * @param widthPercent the tag's argument: the share of the paper's width to print at
 * @param settings the compile settings, carrying the paper width and what the pre-pass resolved
 * @returns the directive to send
 * @throws Error if the dots for this width were neither synced nor resolved, which is a server bug
 */
function toWireImage(ref: string, widthPercent: number, settings: CompileSettings): WireDirective {
	const source = resolved(ref, settings);
	const { widthDots } = imageGeometry(source, widthPercent, settings.columns);

	const raster = source.inline?.get(widthDots);
	if (raster) {
		return {
			type: "IMAGE",
			source: {
				kind: "INLINE",
				widthDots: raster.widthDots,
				heightDots: raster.heightDots,
				data: raster.packed.toString("base64"),
			},
		};
	}

	if (widthDots !== dotWidth(settings.columns)) {
		throw new Error(
			`The image '${ref}' prints ${widthDots} dots wide, a width no raster was synced or resolved for; resolveImages must run first`,
		);
	}

	return { type: "IMAGE", source: { kind: "REF", ref, widthDots } };
}
