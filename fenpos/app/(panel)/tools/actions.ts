"use server";

import { requireSession } from "@/lib/auth/require-session";
import { prisma } from "@/lib/db";
import type { Codepage, Linefeed, UnsupportedPolicy } from "@/lib/domain/enums";
import { ApiError } from "@/lib/errors";
import { submitJob } from "@/lib/jobs/dispatch";
import { sendRawWrite } from "@/lib/link/commands";
import { logger } from "@/lib/logger";
import { dotWidth, type SymbolSpec, symbolSvg } from "@/lib/markup/blocks";
import {
	type CompileSettings,
	collectElementErrors,
	compile,
	countOutputLines,
	type DeviceSettings,
	layOut,
	type PrintRequest,
	readRequest,
} from "@/lib/markup/compiler";
import type { Directive, Line as ModelLine } from "@/lib/markup/model";
import { resolveImages } from "@/lib/markup/resolve-images";
import { globalLimits } from "@/lib/settings/settings-service";

/**
 * Server actions behind the Tools tab.
 *
 * Compiling happens here rather than in the browser, deliberately. A preview built from a second
 * implementation would agree with the real pipeline right up until it mattered, and the whole
 * value of a preview is that what it shows is what will print.
 */

/**
 * One symbol as the paper preview draws it.
 *
 * Arrives already drawn and already measured, rather than as something for the browser to work out.
 * Both come from `lib/markup/blocks.ts`, which is also what the compiler charged the line budget
 * against, so the symbol on screen is the symbol that was paid for — at the height it was paid for,
 * and at its true share of the paper's width. Encoding on this side also keeps `bwip-js`, which
 * statically carries every symbology it supports, out of the panel's bundle.
 */
export interface PreviewBlock {
	spec: SymbolSpec;
	/** The symbol itself, as an SVG document. */
	svg: string;
	/** Printed lines this symbol occupies, as charged against `maxOutputLines`. */
	heightLines: number;
	/** Its printed width as a share of the paper's own, where 1 is the full sheet. */
	widthFraction: number;
}

/** One line as the paper preview renders it. */
export interface PreviewLine {
	spans: { text: string; bold: boolean; underline: number; invert: boolean; widthMult: number }[];
	align: "LEFT" | "CENTER" | "RIGHT";
	/** Symbols printed on this line, drawn at the height they were charged. */
	blocks: PreviewBlock[];
	/** Directives that print nothing, drawn as a marker rather than as blank paper. */
	marker: string | null;
}

/** One thing wrong with the markup, worded and positioned as the API would report it. */
export interface PreviewError {
	code: string;
	message: string;
	/** The status the API would answer this with. */
	status: number;
	/** 1-based element, or null for a failure that belongs to the request rather than a line. */
	line: number | null;
	/** 1-based character within the element, or null when the failure has no position. */
	column: number | null;
}

/** What compiling produced: paper and its measurements, or everything wrong with it. */
export interface PreviewResult {
	lines: PreviewLine[] | null;
	columns: number;
	/** Empty when the markup compiles. Every element is checked, not only the first to fail. */
	errors: PreviewError[];
	/** Lines that will advance the paper, and the ceiling they are checked against. */
	outputLines: number;
	maxOutputLines: number;
	/** What will terminate each printed line. */
	linefeed: Linefeed;
}

/**
 * Compiles markup for a device and returns what it would print.
 *
 * @param deviceId the device whose width and codepage to compile against
 * @param source the markup, one element per line
 * @param linefeed what will terminate each line, or null to use the device's own setting
 * @returns the paper and its measurements, or everything wrong with it
 */
export async function preview(
	deviceId: string,
	source: string,
	linefeed: Linefeed | null = null,
): Promise<PreviewResult> {
	// Outside the try: an absent session redirects, and `redirect` signals by throwing. Catching
	// it here would turn being signed out into a toast over a panel that no longer works.
	await requireSession();

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
		const limits = {
			maxLines: device.maxLines ?? installed.maxLines,
			maxLineChars: device.maxLineChars ?? installed.maxLineChars,
			maxTotalChars: device.maxTotalChars ?? installed.maxTotalChars,
			maxOutputLines: device.maxOutputLines ?? installed.maxOutputLines,
		};

		// Everything the preview reports about a failure, minus the failures themselves. Repeated
		// on each early return so the footer's measurements are always present and honest.
		const measured = {
			lines: null,
			columns: device.columns,
			outputLines: 0,
			maxOutputLines: limits.maxOutputLines,
			linefeed: linefeed ?? deviceSettings.defaultLinefeed,
		} as const;

		// The chosen ending goes through the body, exactly as Print sends it, so the footer reports
		// what a real request would resolve to rather than restating the device's setting. Omitted
		// when null, because absence is how the body asks for the device's own.
		const data = source.split("\n");
		const body = linefeed ? { data, linefeed } : { data };

		// Request-level validation first, and on its own: it fails for the body as a whole — too
		// many elements, too many characters — which is one problem, not one per line.
		let request: PrintRequest;
		try {
			request = readRequest(body, limits, deviceSettings);
		} catch (error) {
			return { ...measured, errors: [asPreviewError(error)] };
		}

		const elementErrors = collectElementErrors(request, deviceSettings);
		if (elementErrors.length > 0) {
			return { ...measured, errors: elementErrors.map(asPreviewError) };
		}

		// After the element errors, deliberately: markup that does not compile has no business
		// making this server fetch a URL, and whoever is mid-edit should not wait for one to find
		// out about an unclosed tag. A refusal here — a deleted asset, a host that will not answer —
		// is the caller's to fix like any other, so it is reported beside them rather than as a
		// server fault, and the preview keeps its measurements.
		let settings: CompileSettings;
		try {
			settings = { ...deviceSettings, images: await resolveImages(request.data) };
		} catch (error) {
			return { ...measured, errors: [asPreviewError(error)] };
		}

		const job = compile("preview", device.name, request, limits, settings);

		// The same lines the job was built from, before they lost what the wire has no field for: a
		// symbol's measured height. Laying out again is the preview's cost alone, and the preview is
		// debounced. The two arrays are the same lines in the same order, one entry each.
		const laidOut = layOut(request, settings);

		return {
			columns: device.columns,
			errors: [],
			outputLines: countOutputLines(request, settings),
			maxOutputLines: limits.maxOutputLines,
			linefeed: request.linefeed,
			lines: job.lines.map((line, index) => ({
				align: line.align,
				blocks: blocksOf(laidOut[index], dotWidth(device.columns)),
				marker: describe(laidOut[index]),
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
			return { ...blank, errors: [asPreviewError(error)] };
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
 * Flattens an API error into the shape the preview renders.
 *
 * Position comes from `details`, which is untyped by design — different codes carry different
 * facts — so each field is read defensively and falls back to "no position" rather than to a
 * number that would point somewhere wrong.
 *
 * @param error the failure, expected to be an {@link ApiError}
 * @returns the error as the preview reports it
 */
function asPreviewError(error: unknown): PreviewError {
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

/**
 * Describes the directives on a line that print nothing, or null when it has none.
 *
 * A cut, a feed and a drawer pulse leave no ink, so there is nothing for the preview to draw and a
 * marker is what says where they happen. A rule and the three symbols are absent on purpose: they
 * do print, and the preview draws them as the paper they will become.
 *
 * @param line the laid-out line
 * @returns the marker text, or null when the line has nothing to mark
 */
function describe(line: ModelLine): string | null {
	const markers = line.directives.flatMap((directive) => {
		switch (directive.kind) {
			case "CUT":
				return [`cut (${directive.mode.toLowerCase()})`];
			case "FEED":
				return [`feed ${directive.lines}`];
			case "DRAWER":
				return [`drawer (pin ${directive.pin})`];
			default:
				return [];
		}
	});

	return markers.length === 0 ? null : markers.join(", ");
}

/**
 * Collects the symbols printed on a line, each drawn and sized as it will print.
 *
 * The size is read off the directive rather than measured again. Measuring it a second time would
 * produce the same numbers today and would be a second place for them to come from tomorrow, which
 * is exactly the drift the shared measurement exists to prevent.
 *
 * @param line the laid-out line
 * @param paperDots the paper's printable width in dots
 * @returns its symbols, in the order they appear
 * @throws SymbolEncodeError if the encoder refuses content it has already measured, which would
 *         mean this module and the parser disagree about what a symbol is
 */
function blocksOf(line: ModelLine, paperDots: number): PreviewBlock[] {
	return line.directives.flatMap((directive): PreviewBlock[] => {
		const measured = measuredSymbol(directive);
		if (measured === null) {
			return [];
		}
		return [
			{
				spec: measured.spec,
				svg: symbolSvg(measured.spec),
				heightLines: measured.heightLines,
				widthFraction: measured.widthDots / paperDots,
			},
		];
	});
}

/**
 * Reads a directive as the symbol it prints and the size it was measured at, or null when it
 * prints no symbol.
 *
 * @param directive one of a line's directives
 * @returns what to draw and how big it is, or null
 */
function measuredSymbol(directive: Directive): { spec: SymbolSpec; heightLines: number; widthDots: number } | null {
	switch (directive.kind) {
		case "QR":
			return { spec: { kind: "QR", content: directive.content, size: directive.size }, ...size(directive) };
		case "BARCODE":
			return { spec: { kind: "BARCODE", content: directive.content, system: directive.system }, ...size(directive) };
		case "PDF417":
			return {
				spec: { kind: "PDF417", content: directive.content, errorLevel: directive.errorLevel },
				...size(directive),
			};
		default:
			return null;
	}
}

/** The measured size a symbol directive carries. */
function size(directive: { heightLines: number; widthDots: number }): { heightLines: number; widthDots: number } {
	return { heightLines: directive.heightLines, widthDots: directive.widthDots };
}

/** The outcome of sending something to a printer. */
export interface SendResult {
	error: string | null;
	message: string | null;
}

/**
 * Prints the markup currently in the editor.
 *
 * Goes through the ordinary submission path, so it is recorded as a job like any other and the
 * preview is not a special case that could behave differently from a real print.
 *
 * @param deviceId the device to print on
 * @param source the markup, one element per line
 * @param linefeed what terminates each line, or null to use the device's own setting
 * @returns the job id, or why it could not be printed
 */
export async function printMarkup(
	deviceId: string,
	source: string,
	linefeed: Linefeed | null = null,
): Promise<SendResult> {
	await requireSession();

	try {
		const data = source.split("\n");
		// Omitted rather than sent as null when the device's setting is wanted: the body accepts
		// exactly `data` and `linefeed`, and "absent" is how it says "whatever the device is set to".
		const job = await submitJob(deviceId, linefeed ? { data, linefeed } : { data });
		return { error: null, message: `Queued ${job.id}.` };
	} catch (error) {
		if (error instanceof ApiError) {
			return { error: error.message, message: null };
		}
		logger.error("Tools print failed", error);
		return { error: "Something went wrong. Check the server log.", message: null };
	}
}

/**
 * Writes raw bytes to a printer.
 *
 * Admin session only, and there is no permission that can grant it to a key. These bytes are the
 * printer's own language: a wrong sequence can leave a device needing a power cycle, and no
 * machine client has any business sending one.
 *
 * @param deviceId the device to write to
 * @param bytes the bytes to write
 * @returns what the agent reported, or why it could not be sent
 */
export async function writeRaw(deviceId: string, bytes: number[]): Promise<SendResult> {
	await requireSession();

	try {
		const device = await prisma.device.findUnique({
			where: { id: deviceId },
			select: { name: true, agentId: true },
		});
		if (!device) {
			throw new ApiError("unknown_device", "That printer no longer exists.");
		}
		if (bytes.length === 0) {
			throw new ApiError("missing_field", "There are no bytes to send.");
		}

		const encoded = Buffer.from(Uint8Array.from(bytes)).toString("base64");

		// Logged here as well as on the agent. Two records of the same act, on two machines, is
		// what makes this auditable if either one is later in question.
		logger.warn("Raw write requested from the panel", {
			agentId: device.agentId,
			deviceName: device.name,
			byteCount: bytes.length,
		});

		const message = await sendRawWrite(device.agentId, device.name, encoded);
		return { error: null, message: message ?? "Sent." };
	} catch (error) {
		if (error instanceof ApiError) {
			return { error: error.message, message: null };
		}
		logger.error("Raw write failed", error);
		return { error: "Something went wrong. Check the server log.", message: null };
	}
}
