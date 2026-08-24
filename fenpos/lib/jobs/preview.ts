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
import { resolveImages } from "@/lib/markup/resolve-images";
import { globalLimits } from "@/lib/settings/settings-service";

/**
 * Compiling a receipt without printing it.
 *
 * **The same path a print takes, stopped one step short of the wire.** That is the whole value of a
 * preview: `readRequest`, the element checks, image resolution and `compile` all run exactly as they
 * do for a real submission, so what comes back is what the printer would produce rather than an
 * approximation of it. A preview built from a second, simpler code path would agree with the printer
 * right up until the day it mattered.
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
 * Compiles a print body against a device and reports what it would print.
 *
 * @param deviceId the device whose width and codepage to compile against
 * @param body the print request body, in exactly the shape `POST /print` accepts
 * @returns the compiled lines and their measurements, or everything wrong with the body
 */
export async function compilePreview(deviceId: string, body: unknown): Promise<CompiledPreview> {
	try {
		const device = await prisma.device.findUnique({ where: { id: deviceId } });
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

		// Everything reported about a failure, minus the failures themselves. Repeated on each early
		// return so the measurements are always present and honest.
		const measured = {
			lines: null,
			columns: device.columns,
			outputLines: 0,
			maxOutputLines: limits.maxOutputLines,
			linefeed: deviceSettings.defaultLinefeed,
		} as const;

		// Request-level validation first, and on its own: it fails for the body as a whole — too many
		// elements, too many characters — which is one problem, not one per line.
		let request: PrintRequest;
		try {
			request = readRequest(body, limits, deviceSettings);
		} catch (error) {
			return { ...measured, errors: [faultOf(error)] };
		}

		const elementErrors = collectElementErrors(request, deviceSettings);
		if (elementErrors.length > 0) {
			return { ...measured, errors: elementErrors.map(faultOf) };
		}

		// After the element errors, deliberately: markup that does not compile has no business making
		// this server fetch a URL. A refusal here — a deleted asset, a host that will not answer — is
		// the caller's to fix like any other, so it is reported beside them and the measurements stay.
		let settings: CompileSettings;
		try {
			settings = { ...deviceSettings, images: await resolveImages(request.data, deviceSettings.columns) };
		} catch (error) {
			return { ...measured, errors: [faultOf(error)] };
		}

		const job = compile("preview", device.name, request, limits, settings);

		return {
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
		};
	} catch (error) {
		const blank = { lines: null, columns: 0, outputLines: 0, maxOutputLines: 0, linefeed: "LF" as Linefeed };

		if (error instanceof ApiError) {
			return { ...blank, errors: [faultOf(error)] };
		}

		logger.error("Preview failed", error);
		return {
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
		};
	}
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
