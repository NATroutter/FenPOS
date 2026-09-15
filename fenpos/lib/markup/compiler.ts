import type { Codepage, Linefeed, UnsupportedPolicy } from "@/lib/domain/enums";
import { ApiError } from "@/lib/errors";
import type { CompiledJob, Directive as WireDirective, Line as WireLine, Span as WireSpan } from "@/lib/link/protocol";
import { dotWidth } from "@/lib/markup/blocks";
import { validateCharset } from "@/lib/markup/charset";
import type { Document, ParseOptions } from "@/lib/markup/document";
import { MARKUP_ERRORS, MarkupError, UnsupportedCharacterError } from "@/lib/markup/errors";
import { resolveFills } from "@/lib/markup/fill";
import { flattenLine, needsRaster, splitLines } from "@/lib/markup/flatten";
import { type ImageSource, imageGeometry, type ResolvedImages } from "@/lib/markup/images";
import { isDirectiveOnly, type Line } from "@/lib/markup/model";
import { normaliseSource, parseDocument, type VariableContext } from "@/lib/markup/parser";
import { wrapLine } from "@/lib/markup/wrapper";
import { readSuppliedVariables, type SuppliedValue } from "@/lib/variables/supplied";

/**
 * Turns a request body into a job an agent can print, or explains precisely why it cannot.
 *
 * **Every stage runs synchronously, before the request is answered.** That is the property the
 * whole API is built around: once a job is accepted it can only fail for hardware reasons, and
 * every content problem has already been reported to the caller with the line and column that
 * caused it. A `400` naming the exact character a codepage cannot represent is worth far more
 * than a job that is accepted and then quietly fails somewhere behind a printer.
 *
 * Stages are ordered cheapest-first: the request's line count is enforced before the document is
 * parsed, so an oversized request is refused without doing the work it was trying to provoke. The
 * character limits follow the parse, because only a parsed document knows which of its lines print.
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
 *
 * `data` carries the same precedent inside itself: an array of lines is refused by name rather than
 * joined for the caller, because a receipt whose tags now span lines would print something other
 * than what the array asked for and nothing would say so.
 */
const ALLOWED_FIELDS = new Set(["data", "linefeed", "variables"]);

/** Limits applied to one request. */
export interface CompileLimits {
	maxLines: number;
	maxLineChars: number;
	maxTotalChars: number;
	maxOutputLines: number;
	maxBlockDepth: number;
	maxTableCells: number;
	maxSeriesPoints: number;
	maxRasterBytes: number;
	maxFontHeight: number;
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
	/**
	 * The values `{name}` may resolve to, or null when variables are switched off.
	 *
	 * Nullable where `images` is required, and the asymmetry is deliberate. An absent image map would
	 * compile a receipt whose images cost nothing — a job accepted against a budget it was never
	 * measured for, which is a wrong answer wearing a default's clothes. Null here is not an absence
	 * of information: it is the complete meaning "braces are ordinary text", which is what
	 * `variables.enabled: false` says and what every receipt did before this feature existed.
	 */
	variables: VariableContext | null;
}

/** What a caller asked to print, after the request body has been read. */
export interface PrintRequest {
	/** The whole receipt, one printed line per line of text, with `\r\n` already normalised away. */
	data: string;
	linefeed: Linefeed;
	/**
	 * Values the caller supplied for this job — literal text, or a date for this server to compute.
	 * Empty when they supplied none.
	 */
	variables: Record<string, SuppliedValue>;
}

/**
 * Reads a request body and checks what can be checked without parsing it.
 *
 * The line count is one of those, and is the cheapest thing that can refuse an oversized body: it is
 * a count of newlines in the raw string, so a caller computing it gets the same number this does.
 * The character limits are not, and moved to {@link layOut}: a line lying inside a content tag
 * prints nothing of its own, and which lines those are is only known once the document has been
 * parsed.
 *
 * Takes the device's settings rather than the whole {@link CompileSettings}, because it runs before
 * the images are resolved: what a request refers to cannot be known until its markup has been read,
 * and reading it is what this does.
 *
 * The `variables` field is read here rather than left for `resolveVariables`, and by a function that
 * imports nothing `server-only`: shape and per-value checks — a malformed name, a value over the
 * length cap, a control character — belong with the rest of the body's limit checks, before the
 * document is parsed and before a database is ever consulted. `readSuppliedVariables` comes from
 * `@/lib/variables/supplied`, never from `resolve-variables.ts`, precisely so this file stays free of
 * Prisma; see that module's own header for why.
 *
 * @param body the parsed JSON body
 * @param limits the limits to apply
 * @param settings the device's print settings, supplying defaults
 * @param maxVariableValueChars the install's cap on one supplied variable value's length
 * @returns the request, validated
 * @throws ApiError when the body is malformed or exceeds a limit
 */
export function readRequest(
	body: unknown,
	limits: CompileLimits,
	settings: DeviceSettings,
	maxVariableValueChars: number,
): PrintRequest {
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
					: `Unknown field '${key}'; this request accepts 'data', 'linefeed' and 'variables'`,
			);
		}
	}

	const data = record.data;
	if (data === undefined || data === null) {
		throw new ApiError("missing_field", "'data' is required");
	}
	if (Array.isArray(data)) {
		throw new ApiError(
			"invalid_type",
			"'data' is no longer an array of lines. Send one string, with a newline between lines.",
		);
	}
	if (typeof data !== "string") {
		throw new ApiError(
			"invalid_type",
			"'data' must be a string: the receipt as markup, one printed line per line of text",
		);
	}

	// Normalised before anything is counted, so a caller sending Windows line endings is charged the
	// same number of lines as one sending Unix endings for the same receipt.
	const normalised = normaliseSource(data);
	const lineCount = normalised.length === 0 ? 1 : normalised.split("\n").length;
	if (lineCount > limits.maxLines) {
		throw new ApiError("too_many_lines", `At most ${limits.maxLines} lines are allowed, got ${lineCount}`);
	}

	return {
		data: normalised,
		linefeed: readLinefeed(record.linefeed, settings),
		variables: readSuppliedVariables(record.variables, maxVariableValueChars),
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
 * @throws ApiError when the markup is malformed or the output exceeds a limit
 */
export function compile(
	jobId: string,
	deviceName: string,
	request: PrintRequest,
	limits: CompileLimits,
	settings: CompileSettings,
): CompiledJob {
	const lines = layOut(request, settings, limits);
	requireOutputWithinLimit(lines, limits, settings);

	return {
		jobId,
		device: deviceName,
		linefeed: request.linefeed,
		lines: lines.map((line) => toWireLine(line, settings)),
	};
}

/**
 * Parses the document, then validates and wraps each of its lines.
 *
 * The document is built once and in one place, so every shape rule — which tag may close which,
 * which line a scope spanning several of them styles — is settled before anything here runs. What
 * is left is per-line work: the character limits, the symbols, the codepage, the fills and the
 * wrapper.
 *
 * Positional failures raised by the parser and the charset check are translated into request-level
 * errors carrying the line they were written on, so a caller can point at the exact line as well as
 * the exact character.
 *
 * Exported for the paper preview, which needs a symbol's measured `heightLines` to draw it at the
 * height it was charged. That figure is deliberately absent from the wire — see {@link toWireLine}
 * — so the preview reads the lines at this stage instead. {@link compile} maps these lines to the
 * wire one for one and in order, so the two can be read side by side.
 *
 * @param request the validated request
 * @param settings the device's compile settings
 * @param limits the limits the document's characters are charged against
 * @returns one line per line of paper, with every fill already expanded, before the rule is
 *          expanded and the symbols leave for the agent
 * @throws ApiError when the markup is malformed or a line exceeds a character limit
 */
export function layOut(request: PrintRequest, settings: CompileSettings, limits: CompileLimits): Line[] {
	const document = checkDocument(request, settings.variables, limits);

	const lines: Line[] = [];
	for (const top of splitLines(document.nodes)) {
		try {
			if (needsRaster(top.nodes)) {
				throw new Error(`line ${top.number} needs the layout engine and nothing produces such a line`);
			}
			const parsed = flattenLine(top.nodes);
			requireSymbolsFitThePaper(parsed, top.number, settings.columns);
			const checked = validateCharset(parsed, settings.codepage, settings.onUnsupported);
			// After this line no fill remains, which is what lets the wrapper, the wire types and
			// the agent all stay ignorant of the tag. It runs after the charset check so that an
			// unprintable fill character is reported once, at the column the caller wrote it.
			const filled = resolveFills(checked, settings.columns);
			const wrap = filled.wrap ?? settings.defaultWrap;
			if (wrap) {
				lines.push(...wrapLine(filled, settings.columns));
			} else {
				lines.push(filled);
			}
		} catch (error) {
			throw translate(error, top.number);
		}
	}

	return lines;
}

/**
 * Parses a document, turning a positional failure into the API error that reports it.
 *
 * A parse failure ends the whole document rather than one line of it: the tree cannot be built past
 * the point it went wrong, so there is nothing to carry on from. The line it names comes from the
 * error itself, which is why the line passed to {@link translate} here is never read.
 *
 * @param data the whole receipt, as the caller wrote it
 * @param variables the values `{name}` may resolve to, or null when variables are switched off
 * @param options the bounds to parse under, or the defaults
 * @returns the document
 * @throws ApiError when the markup is malformed
 */
function parseDocumentOrTranslate(
	data: string,
	variables: VariableContext | null,
	options?: Partial<ParseOptions>,
): Document {
	try {
		return parseDocument(data, variables, options);
	} catch (error) {
		throw translate(error, 0);
	}
}

/**
 * Parses a request and charges it against the character limits, in the one place both happen.
 *
 * {@link layOut} and {@link collectDocumentErrors} each need exactly this pair, in this order — a
 * document is not known to be printable until it has been charged. Both of those callers want the
 * parse failure itself, positioned and reported like any other markup mistake — which is exactly what
 * a caller checking a request before it has a job row to fail against must *not* raise; see
 * {@link requireDocumentWithinLimits} for that case.
 *
 * @param request the validated request
 * @param variables the values `{name}` may resolve to, or null when variables are switched off
 * @param limits the limits the document's characters are charged against
 * @returns the parsed document
 * @throws ApiError when the markup is malformed or a line exceeds a character limit
 */
export function checkDocument(
	request: PrintRequest,
	variables: VariableContext | null,
	limits: CompileLimits,
): Document {
	const document = parseDocumentOrTranslate(request.data, variables);
	requireCharsWithinLimits(document, limits);
	return document;
}

/**
 * Charges a request's characters against the character limits, without ever reporting that the
 * document failed to parse.
 *
 * **Why a parse failure is silence here rather than a throw.** This exists for a caller that must
 * refuse an over-limit document before doing anything it cannot take back — `dispatch.ts` calls it
 * ahead of the `<image>` fetch and before the job row exists — but a markup mistake such as an
 * unknown tag or an unclosed one is not this function's failure to report. That has always settled a
 * `FAILED` job row from inside {@link compile}, once the row exists to fail, and job history and the
 * statistics both depend on that row existing. Raising the identical `ApiError` here instead would
 * refuse the request one step earlier and silently stop it from ever becoming that row. So when the
 * parse itself fails, this simply has nothing to charge and returns — `compile` parses again later
 * and raises the same error once there is a row for it to fail.
 *
 * @param request the validated request
 * @param variables the values `{name}` may resolve to, or null when variables are switched off
 * @param limits the limits the document's characters are charged against
 * @throws ApiError when a line or the whole request exceeds a character limit; never for a parse
 *         failure, which this leaves for {@link compile} to raise once a job row exists
 */
export function requireDocumentWithinLimits(
	request: PrintRequest,
	variables: VariableContext | null,
	limits: CompileLimits,
): void {
	let document: Document;
	try {
		document = parseDocumentOrTranslate(request.data, variables);
	} catch {
		return;
	}
	requireCharsWithinLimits(document, limits);
}

/**
 * Charges a document's lines against the per-line and whole-request character limits.
 *
 * Counted from the source rather than from what prints, because a tag costs a caller characters
 * without putting any on the paper, and a limit measured on the output would be one no client could
 * compute for itself.
 *
 * A line lying inside a content tag is skipped. It produces no printed line of its own — an
 * `<image>` reference wrapped onto its own line is the plain case — so charging it would refuse a
 * receipt for characters that only exist because the caller broke a tag across lines.
 *
 * @param document the parsed document
 * @param limits the limits to apply
 * @throws ApiError naming the line that crossed one
 */
function requireCharsWithinLimits(document: Document, limits: CompileLimits): void {
	let total = 0;
	for (const line of document.lines) {
		if (line.interior) {
			continue;
		}
		if (line.chars > limits.maxLineChars) {
			throw new ApiError(
				"line_too_long",
				`Line ${line.number} has ${line.chars} characters, more than the limit of ${limits.maxLineChars}`,
				{ line: line.number },
			);
		}
		total += line.chars;
		if (total > limits.maxTotalChars) {
			throw new ApiError(
				"text_too_large",
				`The request exceeds ${limits.maxTotalChars} characters at line ${line.number}`,
				{ line: line.number },
			);
		}
	}
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
 * @param limits the limits the document's characters are charged against
 * @returns the number of lines that advance the paper
 */
export function countOutputLines(request: PrintRequest, settings: CompileSettings, limits: CompileLimits): number {
	return countTextLines(layOut(request, settings, limits), settings);
}

/**
 * Collects everything wrong with a request's lines, instead of stopping at the first.
 *
 * {@link compile} stops at the first failure, and is right to: a request either prints or it does
 * not, and doing more work on a body that is already a `400` buys nothing. The preview is read by
 * someone in the middle of fixing the markup, and handing them one mistake per round trip makes
 * four mistakes take four times as long to find.
 *
 * What can be collected is what belongs to one line — the symbols and the codepage check. A parse
 * failure is not one of those however positioned it is: the tree cannot be built past the point it
 * went wrong, so the document yields exactly one error and there is nothing after it to report.
 *
 * Takes the device's settings rather than the whole {@link CompileSettings} so that it can run
 * *before* the images are resolved, which is what it is worth: markup with an unclosed tag has no
 * business making this server fetch a URL, and the person fixing it should not wait for one either.
 *
 * Takes `variables` as its own parameter rather than through `CompileSettings` for the same reason:
 * `resolveVariables` — a database read — has to finish before this runs, since `unknown_variable` is
 * one of the errors it must be able to report, but resolving images has not happened yet and may
 * never need to.
 *
 * @param request the validated request
 * @param settings the device's print settings
 * @param variables the values `{name}` may resolve to, or null when variables are switched off
 * @param limits the limits the document's characters are charged against
 * @returns every error, in line order; empty when the markup is sound
 */
export function collectDocumentErrors(
	request: PrintRequest,
	settings: DeviceSettings,
	variables: VariableContext | null,
	limits: CompileLimits,
): ApiError[] {
	let document: Document;
	try {
		document = checkDocument(request, variables, limits);
	} catch (error) {
		if (error instanceof ApiError) {
			return [error];
		}
		throw error;
	}

	const errors: ApiError[] = [];
	for (const top of splitLines(document.nodes)) {
		try {
			if (needsRaster(top.nodes)) {
				continue;
			}
			const parsed = flattenLine(top.nodes);
			// Collected alongside the charset failures, so the preview shows an over-wide symbol as a
			// refusal while it is being written rather than only when the job is submitted.
			requireSymbolsFitThePaper(parsed, top.number, settings.columns);
			validateCharset(parsed, settings.codepage, settings.onUnsupported);
		} catch (error) {
			const translated = translate(error, top.number);
			if (!(translated instanceof ApiError)) {
				// Not a markup failure at all, so not something to collect and carry on from.
				throw translated;
			}
			errors.push(translated);
		}
	}

	return errors;
}

/**
 * Refuses a symbol measured wider than the device's paper.
 *
 * **Nothing else in the system says no to this.** A symbol wider than the print head does not come
 * out smaller; it comes out with bars missing off the right edge, and a barcode with bars missing is
 * not a narrower barcode — it is one that will not scan, discovered by whoever is holding the
 * receipt. The check is one comparison between two numbers the compiler already holds, and it fails
 * closed.
 *
 * It was previously left to the preview's over-wide marker, on the grounds that showing the operator
 * was enough. That mitigation did not exist as described: the marker was wrong for Code 128, which
 * was measured in the wrong code set and under-reported by 43%, and it is still wrong for ITF, whose
 * width is measured at a 2:1 bar ratio while the renderers draw 3:1. A warning that does not fire is
 * not a warning.
 *
 * Images are not checked here: `<image>` is bounded to 100% of the paper by the parser, so it cannot
 * reach this state.
 *
 * @param line the parsed line
 * @param lineNumber the line of the document it was written on, for the refusal to name
 * @param columns the device's width in printer columns
 * @throws MarkupError naming the tag and its column
 */
function requireSymbolsFitThePaper(line: Line, lineNumber: number, columns: number): void {
	const paper = dotWidth(columns);
	for (const directive of line.directives) {
		if (!("widthDots" in directive) || directive.widthDots <= paper) {
			continue;
		}
		const tag = directive.kind.toLowerCase();
		throw new MarkupError(
			MARKUP_ERRORS.symbolTooWide,
			lineNumber,
			directive.sourceColumn,
			tag,
			`This <${tag}> prints ${directive.widthDots} dots wide, more than the ${paper} this device's paper has. Shorten its content, or print it on wider paper.`,
		);
	}
}

/**
 * Turns a positional failure into the API error that reports it.
 *
 * A {@link MarkupError} carries the line it was raised on, because the parser reads a whole document
 * and knows it; the `line` passed here is only for a failure found while laying one line out, which
 * is where an {@link UnsupportedCharacterError} comes from.
 */
function translate(error: unknown, line: number): unknown {
	if (error instanceof MarkupError) {
		return new ApiError(error.code, error.message, {
			line: error.line,
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
			// Only when the character came out of a substituted value. `detail` is where every other
			// positional failure puts the token at fault, and here it is what stands in for a column
			// that can only point at the reference rather than into the value behind it.
			...(error.variable === null ? {} : { detail: error.variable }),
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
 * reference this compile will meet — it reads the same document with the same parser — and refuses
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
