import "server-only";
import { prisma } from "@/lib/db";
import type { Codepage, Linefeed, UnsupportedPolicy } from "@/lib/domain/enums";
import { ApiError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import {
	type CompileLimits,
	type CompileSettings,
	collectElementErrors,
	compile,
	countOutputLines,
	type DeviceSettings,
	type PrintRequest,
	readRequest,
} from "@/lib/markup/compiler";
import type { VariableContext } from "@/lib/markup/parser";
import { resolveImages } from "@/lib/markup/resolve-images";
import { resolveVariables } from "@/lib/markup/resolve-variables";
import { globalLimits, integerSetting } from "@/lib/settings/settings-service";

/**
 * Compiling a receipt without printing it.
 *
 * **The same path a print takes, stopped one step short of the wire.** That is the whole value of a
 * preview: `readRequest`, variable resolution, the element checks, image resolution and `compile` all
 * run exactly as they do for a real submission, so what comes back is what the printer would produce
 * rather than an approximation of it. A preview built from a second, simpler code path would agree
 * with the printer right up until the day it mattered.
 *
 * Lifted out of the Tools tab's server action, where it was reachable only from a browser session.
 * The panel keeps its presentation layer — a symbol's measured height, the block markers it draws —
 * on top of what this returns; none of that is anything an API caller can use.
 *
 * Nothing here writes. There is no job row, no agent, and no paper: a caller may compile as often as
 * they like and the only cost is this process's own.
 */

/** One thing wrong with a receipt, positioned where a caller can find it. */
export interface PreviewFault {
	code: string;
	message: string;
	/** The status the print endpoint would answer this with. */
	status: number;
	/** 1-based element, or null for a failure that belongs to the request rather than a line. */
	line: number | null;
	/** 1-based character within the element, or null when the failure has no position. */
	column: number | null;
}

/** One compiled line, as the printer would lay it out. */
export interface CompiledLine {
	align: string;
	/**
	 * `underline` is 0 for none and 1 or 2 for the two ESC/POS weights, not a boolean; it is
	 * carried through unchanged from the wire span the job was built from.
	 */
	spans: { text: string; bold: boolean; underline: number; invert: boolean; widthMult: number }[];
}

/** What compiling produced: paper and its measurements, or everything wrong with it. */
export interface CompiledPreview {
	columns: number;
	/** Lines that will advance the paper, and the ceiling they are checked against. */
	outputLines: number;
	maxOutputLines: number;
	linefeed: Linefeed;
	/** Null when the receipt did not compile. */
	lines: CompiledLine[] | null;
	/** Empty when it did. Every element is checked, not only the first to fail. */
	errors: PreviewFault[];
}

/**
 * What {@link compilePreviewWithContext} returns: the compiled preview, plus the exact inputs it was
 * compiled from.
 *
 * `request` and `settings` are populated the moment each is produced — `request` as soon as
 * `readRequest` succeeds, `settings` as soon as `resolveImages` does — and stay null before that, so
 * a caller can tell how far the compile got even when `preview.errors` is non-empty. Both are always
 * present together with `preview.lines` on a clean compile.
 */
export interface PreviewWithContext {
	/** What an API caller receives: see {@link compilePreview}. */
	preview: CompiledPreview;
	/** The validated request `preview` was compiled from, or null if it never parsed. */
	request: PrintRequest | null;
	/** The resolved settings `preview` was compiled from, or null if resolution never completed. */
	settings: CompileSettings | null;
}

/**
 * Compiles a print body against a device and reports what it would print, alongside the exact
 * `request` and `settings` the compile used.
 *
 * **Why this exists rather than just {@link compilePreview}.** The Tools panel draws a presentation
 * layer — a symbol's measured height, a directive's marker — on top of the same lines this compiled,
 * by running `layOut` over `request` and `settings` a second time and zipping the result with
 * `preview.lines` by index. That zip is only sound when both arrays came from the same `request` and
 * `settings`. Re-deriving them with a second `readRequest`/`resolveImages` call would not be merely
 * wasteful: `resolveImages` fetches `<image>` URLs over the network, so the gap between the first
 * read and a second is bounded by network latency rather than a database round trip — seconds, not
 * milliseconds. If the device's `columns` changed in that window, the re-read `request` could wrap to
 * a different number of lines than `preview.lines` did, and the index-zip would silently pair the
 * wrong text with the wrong block on screen — no error, just a wrong render. Handing back the one
 * `request` and `settings` this compile actually used is what closes that window, rather than merely
 * shrinking it.
 *
 * `compilePreview` is implemented in terms of this function, so there remains exactly one compile
 * path; it is the public half, because an API caller serialises {@link CompiledPreview} straight to
 * JSON and must not have `request`/`settings` leak into that response.
 *
 * @param deviceId the device whose width and codepage to compile against
 * @param body the print request body, in exactly the shape `POST /print` accepts
 * @param apiKeyName the name of the key asking, or null when the panel is. See {@link compilePreview}
 *        for why this is a parameter rather than a constant
 * @returns the compiled preview, plus the request and settings it was compiled from
 */
export async function compilePreviewWithContext(
	deviceId: string,
	body: unknown,
	apiKeyName: string | null = null,
): Promise<PreviewWithContext> {
	try {
		const device = await prisma.device.findUnique({
			where: { id: deviceId },
			include: { agent: { select: { name: true } } },
		});
		if (!device) {
			throw new ApiError("unknown_device", "That printer no longer exists.");
		}

		const deviceSettings: DeviceSettings = {
			columns: device.columns,
			codepage: device.codepage as Codepage,
			onUnsupported: device.onUnsupported as UnsupportedPolicy,
			defaultWrap: device.defaultWrap,
			defaultLinefeed: device.defaultLinefeed as Linefeed,
		};

		const installed = await globalLimits();
		const limits: CompileLimits = {
			maxLines: device.maxLines ?? installed.maxLines,
			maxLineChars: device.maxLineChars ?? installed.maxLineChars,
			maxTotalChars: device.maxTotalChars ?? installed.maxTotalChars,
			maxOutputLines: device.maxOutputLines ?? installed.maxOutputLines,
		};

		// Everything reported about a failure, minus the failures themselves. Built fresh at each
		// early return so the measurements are always present and honest, and takes the linefeed
		// that is actually known at that point: the device's own default before the body has been
		// validated, and the request's resolved choice from the moment `readRequest` has confirmed
		// it — which may be the caller's own override, exactly as a successful compile reports it.
		const measured = (linefeed: Linefeed) =>
			({
				lines: null,
				columns: device.columns,
				outputLines: 0,
				maxOutputLines: limits.maxOutputLines,
				linefeed,
			}) as const;

		const maxVariableValueChars = await integerSetting("variables.maxValueChars");

		// Request-level validation first, and on its own: it fails for the body as a whole — too many
		// elements, too many characters — which is one problem, not one per line. The body's own
		// linefeed choice, if any, has not been validated yet at this point, so there is nothing sound
		// to report beyond the device's default.
		let request: PrintRequest;
		try {
			request = readRequest(body, limits, deviceSettings, maxVariableValueChars);
		} catch (error) {
			return {
				preview: { ...measured(deviceSettings.defaultLinefeed), errors: [faultOf(error)] },
				request: null,
				settings: null,
			};
		}

		// Resolved before the element errors, even though it is a database read and they are not:
		// `collectElementErrors` parses every element, and `unknown_variable` is one of the errors it
		// has to be able to report.
		//
		// `apiKeyName` comes from the caller and is not hardcoded, because it is the one fact in this
		// context that differs between the two callers and this file's whole claim is that it does
		// not differ from a print. A key previewing through `POST /api/v1/preview` passes its own
		// name, exactly as `submitJob` looks one up; the Tools page passes null, because a receipt
		// composed in the panel genuinely was not submitted by a key. Hardcoding null here made a
		// receipt using an `API_KEY_NAME` variable preview blank and print the key's name — and since
		// the substituted span is then a different length, the wrapping and the reported
		// `outputLines` could differ too, which is the approximation this function exists not to be.
		let variables: VariableContext | null;
		try {
			variables = await resolveVariables({
				deviceId: device.id,
				context: { deviceName: device.name, agentName: device.agent.name, apiKeyName },
				supplied: request.variables,
			});
		} catch (error) {
			return { preview: { ...measured(request.linefeed), errors: [faultOf(error)] }, request, settings: null };
		}

		const elementErrors = collectElementErrors(request, deviceSettings, variables);
		if (elementErrors.length > 0) {
			return {
				preview: { ...measured(request.linefeed), errors: elementErrors.map(faultOf) },
				request,
				settings: null,
			};
		}

		// After the element errors, deliberately: markup that does not compile has no business making
		// this server fetch a URL. A refusal here — a deleted asset, a host that will not answer — is
		// the caller's to fix like any other, so it is reported beside them and the measurements stay.
		let settings: CompileSettings;
		try {
			settings = {
				...deviceSettings,
				variables,
				images: await resolveImages(request.data, deviceSettings.columns, variables),
			};
		} catch (error) {
			return { preview: { ...measured(request.linefeed), errors: [faultOf(error)] }, request, settings: null };
		}

		const job = compile("preview", device.name, request, limits, settings);

		return {
			preview: {
				columns: device.columns,
				errors: [],
				outputLines: countOutputLines(request, settings),
				maxOutputLines: limits.maxOutputLines,
				linefeed: request.linefeed,
				lines: job.lines.map((line) => ({
					align: line.align,
					spans: line.spans.map((span) => ({
						text: span.text,
						bold: span.bold,
						underline: span.underline,
						invert: span.invert,
						widthMult: span.widthMult,
					})),
				})),
			},
			request,
			settings,
		};
	} catch (error) {
		const blank = { lines: null, columns: 0, outputLines: 0, maxOutputLines: 0, linefeed: "LF" as Linefeed };

		if (error instanceof ApiError) {
			return { preview: { ...blank, errors: [faultOf(error)] }, request: null, settings: null };
		}

		logger.error("Preview failed", error);
		return {
			preview: {
				...blank,
				errors: [
					{
						code: "internal_error",
						message: "Something went wrong. Check the server log.",
						status: 500,
						line: null,
						column: null,
					},
				],
			},
			request: null,
			settings: null,
		};
	}
}

/**
 * Compiles a print body against a device and reports what it would print.
 *
 * The public half of {@link compilePreviewWithContext} — the same compile, minus the `request` and
 * `settings` an API caller has no use for and must not see leak into its JSON response.
 *
 * **Pass the key's name whenever a key is asking.** A `CONTEXT` variable with source `API_KEY_NAME`
 * substitutes it, and `submitJob` supplies the real name on the print path, so a preview that left
 * it null would answer a question about a receipt nobody is going to print. Defaulted to null rather
 * than made required so the panel's Tools preview — which no key submitted — says so by saying
 * nothing.
 *
 * @param deviceId the device whose width and codepage to compile against
 * @param body the print request body, in exactly the shape `POST /print` accepts
 * @param apiKeyName the name of the key asking, or null when the panel is
 * @returns the compiled lines and their measurements, or everything wrong with the body
 */
export async function compilePreview(
	deviceId: string,
	body: unknown,
	apiKeyName: string | null = null,
): Promise<CompiledPreview> {
	return (await compilePreviewWithContext(deviceId, body, apiKeyName)).preview;
}

/**
 * Flattens an API error into the shape a preview reports.
 *
 * Position comes from `details`, which is untyped by design — different codes carry different
 * facts — so each field is read defensively and falls back to "no position" rather than to a
 * number that would point somewhere wrong.
 *
 * @param error the failure, expected to be an {@link ApiError}
 * @returns the error as a preview reports it
 */
export function faultOf(error: unknown): PreviewFault {
	if (!(error instanceof ApiError)) {
		throw error;
	}

	return {
		code: error.code,
		message: error.message,
		status: error.status,
		line: typeof error.details.line === "number" ? error.details.line : null,
		column: typeof error.details.column === "number" ? error.details.column : null,
	};
}
