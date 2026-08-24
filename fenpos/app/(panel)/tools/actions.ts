"use server";

import { rasterFor } from "@/lib/assets/asset-service";
import { rasterToPngDataUrl } from "@/lib/assets/preview";
import { requireSession } from "@/lib/auth/require-session";
import { prisma } from "@/lib/db";
import type { Codepage, Linefeed, UnsupportedPolicy } from "@/lib/domain/enums";
import { ApiError } from "@/lib/errors";
import { submitJob } from "@/lib/jobs/dispatch";
import { compilePreview, faultOf } from "@/lib/jobs/preview";
import { sendRawWrite } from "@/lib/link/commands";
import { logger } from "@/lib/logger";
import { dotWidth, LINE_HEIGHT_DOTS, type SymbolSpec, symbolSvg } from "@/lib/markup/blocks";
import {
	type CompileSettings,
	type DeviceSettings,
	layOut,
	type PrintRequest,
	readRequest,
} from "@/lib/markup/compiler";
import { imageGeometry } from "@/lib/markup/images";
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
 * What every block on the paper carries, whichever kind it is.
 *
 * Both figures are measured server-side by the module that charged the line budget for them, so a
 * block on screen is the block that was paid for — at the height it was paid for, and at its true
 * share of the paper's width. The browser is given no measurements to make.
 */
interface DrawnBlock {
	/** Printed lines this block occupies, as charged against `maxOutputLines`. */
	heightLines: number;
	/** Its printed width as a share of the paper's own, where 1 is the full sheet. */
	widthFraction: number;
}

/**
 * One symbol as the paper preview draws it.
 *
 * Arrives already drawn as well as already measured. Both come from `lib/markup/blocks.ts`, which
 * is also what the compiler charged the line budget against. Encoding on this side keeps `bwip-js`,
 * which statically carries every symbology it supports, out of the panel's bundle.
 */
export interface PreviewSymbol extends DrawnBlock {
	kind: "SYMBOL";
	spec: SymbolSpec;
	/** The symbol itself, as an SVG document. */
	svg: string;
}

/**
 * One `<image>` as the paper preview draws it.
 *
 * **The dots, not the picture.** What travels is the finished 1-bit raster — the same one the agent
 * is sent for a stored image at the paper's own width, and the same one the job carries for anything
 * else — rendered as a PNG by `lib/assets/preview.ts`. A preview built from the stored file would
 * show an operator a smooth photograph that no thermal head can produce, which is the one thing a
 * preview may not do; and dithering in the browser would be a second answer to a question that
 * already has one, drifting from the printer's the first time either side changed.
 *
 * The PNG is inlined into the action's result and paid for on every compile. `lib/assets/preview.ts`
 * measured the fixture logo at 384 dots as 9,690 bytes, so of the order of thirteen kilobytes of
 * base64 for a real logo. What keeps that bounded is the debounce the preview already had for the
 * round trip: it is paid per compile, not per keystroke.
 */
export interface PreviewImage extends DrawnBlock {
	kind: "IMAGE";
	/** The reference as it was written between the tags: a stored image's name, or a URL. */
	ref: string;
	/** The dithered raster, as a `data:image/png;base64,…` URI. */
	png: string;
	/**
	 * Lines of paper the dots really cover, before the budget rounded them up to a whole one.
	 *
	 * Separate from {@link DrawnBlock.heightLines} because for an image the two routinely differ and
	 * the difference is visible: a logo 60 dots tall inks two and a half lines and is charged three,
	 * so drawing it at the charged height would stretch it by a fifth. The block occupies what it
	 * was charged; the picture inside it covers only what it inks.
	 */
	inkedLines: number;
}

/** One block printed on a line: a symbol, or an image. */
export type PreviewBlock = PreviewSymbol | PreviewImage;

/** One line as the paper preview renders it. */
export interface PreviewLine {
	spans: { text: string; bold: boolean; underline: number; invert: boolean; widthMult: number }[];
	align: "LEFT" | "CENTER" | "RIGHT";
	/** Symbols and images printed on this line, drawn at the height they were charged. */
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

	// The chosen ending goes through the body, exactly as Print sends it, so the footer reports
	// what a real request would resolve to rather than restating the device's setting. Omitted
	// when null, because absence is how the body asks for the device's own.
	const data = source.split("\n");
	const body = linefeed ? { data, linefeed } : { data };

	const compiled = await compilePreview(deviceId, body);
	if (compiled.errors.length > 0 || compiled.lines === null) {
		return { ...compiled, lines: null };
	}

	try {
		// `compilePreview` already ran this body through `readRequest` and `resolveImages`
		// successfully, but it does not return either — its callers have no use for a symbol's
		// measured height. Both are pure functions of the device and the body, so recomputing them
		// here cannot fail differently than it just did; it only hands the presentation layer what
		// it needs to draw blocks and markers on top of the same compile.
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

		const request: PrintRequest = readRequest(body, limits, deviceSettings);
		const settings: CompileSettings = {
			...deviceSettings,
			images: await resolveImages(request.data, deviceSettings.columns),
		};

		// The same lines `compilePreview` built its job from, before they lost what the wire has no
		// field for: a symbol's measured height. Laying out again is the preview's cost alone, and
		// the preview is debounced. The two arrays are the same lines in the same order, one entry
		// each.
		const laidOut = layOut(request, settings);

		// One line at a time rather than `Promise.all`. Drawing an image can mean decoding and
		// dithering it, and `MAX_IMAGE_DIMENSION` bounds *one* decode — a receipt naming several
		// would otherwise hold that many bitmaps at once and the bound would mean nothing. The same
		// reasoning the Assets tab renders its cards in sequence for, and the preview is debounced.
		const lines: PreviewLine[] = [];
		for (const [index, line] of compiled.lines.entries()) {
			lines.push({
				align: line.align as PreviewLine["align"],
				blocks: await blocksOf(laidOut[index], settings),
				marker: describe(laidOut[index]),
				spans: line.spans,
			});
		}

		return {
			columns: compiled.columns,
			errors: [],
			outputLines: compiled.outputLines,
			maxOutputLines: compiled.maxOutputLines,
			linefeed: compiled.linefeed,
			lines,
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
 * Describes the directives on a line that print nothing, or null when it has none.
 *
 * A cut, a feed and a drawer pulse leave no ink, so there is nothing for the preview to draw and a
 * marker is what says where they happen. A rule, the three symbols and an image are absent on
 * purpose: they do print, and the preview draws them as the paper they will become. An image was
 * the odd one out until it could be drawn — a marker in its place would now be a second description
 * of a line the preview already shows in full.
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
 * Collects the blocks printed on a line, each drawn and sized as it will print.
 *
 * A symbol's size is read off the directive rather than measured again, and an image's comes from
 * `imageGeometry`, the function the compiler charged the budget with. Measuring either a second
 * time would produce the same numbers today and would be a second place for them to come from
 * tomorrow, which is exactly the drift the shared measurement exists to prevent.
 *
 * In order, though nothing can currently exercise it: a block takes its element alone, so a line
 * holds at most one of these beside a drawer pulse.
 *
 * @param line the laid-out line
 * @param settings the compile settings, carrying the paper width and what the pre-pass resolved
 * @returns its blocks, in the order they appear
 * @throws SymbolEncodeError if the encoder refuses content it has already measured, which would
 *         mean this module and the parser disagree about what a symbol is
 * @throws Error if an image reference was never resolved, which would mean the same of the pre-pass
 */
async function blocksOf(line: ModelLine, settings: CompileSettings): Promise<PreviewBlock[]> {
	const paperDots = dotWidth(settings.columns);
	const blocks: PreviewBlock[] = [];

	for (const directive of line.directives) {
		const measured = measuredSymbol(directive);
		if (measured !== null) {
			blocks.push({
				kind: "SYMBOL",
				spec: measured.spec,
				svg: symbolSvg(measured.spec),
				heightLines: measured.heightLines,
				widthFraction: measured.widthDots / paperDots,
			});
		} else if (directive.kind === "IMAGE") {
			blocks.push(await drawnImage(directive.ref, directive.widthPercent, settings));
		}
	}

	return blocks;
}

/**
 * Draws one image as the dots it will print, at the size the compiler charged for them.
 *
 * **Every raster here is one the print path produced or would produce.** A URL, and a stored image
 * at any width other than the paper's own, were dithered by the pre-pass and are already in
 * `settings.images` — the very rasters that will ride inside the job, so the preview cannot show
 * different dots from the ones that are sent. Everything left is a stored image at the paper's own
 * width, whose dots do not travel with the job because they went to the agent with its device
 * configuration; `rasterFor` is what produced those, and it is memoised by asset revision and width,
 * so asking it again here is a map lookup on any agent that has connected since.
 *
 * The width is taken from the dot geometry rather than from the preview's own scales. The sheet
 * measures across in columns and down in lines, and the two do not agree on what a dot is, so a
 * share of the paper's *width* is the only figure that answers "does this fit across my 32 columns".
 *
 * @param ref the reference as written between the tags
 * @param widthPercent the tag's argument: the share of the paper's width to print at
 * @param settings the compile settings, carrying the paper width and what the pre-pass resolved
 * @returns the image as the preview draws it
 * @throws Error if the reference was never resolved, which the compile above would already have
 *         failed on: `resolveImages` must run first
 */
async function drawnImage(ref: string, widthPercent: number, settings: CompileSettings): Promise<PreviewImage> {
	const source = settings.images.get(ref);
	if (!source) {
		throw new Error(`The image '${ref}' was not resolved before previewing; resolveImages must run first`);
	}

	const { widthDots, heightLines } = imageGeometry(source, widthPercent, settings.columns);
	const raster = source.inline?.get(widthDots) ?? (await rasterFor(ref, widthDots));

	return {
		kind: "IMAGE",
		ref,
		png: await rasterToPngDataUrl(raster),
		heightLines,
		// The raster's own height rather than the geometry's, though `images.test.ts` pins them to
		// each other against jimp's resize: if they ever came apart, drawing the dots that exist is
		// what would make it visible instead of quietly squashing them into what was charged.
		inkedLines: raster.heightDots / LINE_HEIGHT_DOTS,
		widthFraction: raster.widthDots / dotWidth(settings.columns),
	};
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
