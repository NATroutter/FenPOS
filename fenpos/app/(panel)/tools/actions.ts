"use server";

import { getCurrentSession } from "@/lib/auth/session-cookie";
import { prisma } from "@/lib/db";
import type { Codepage, Linefeed, UnsupportedPolicy } from "@/lib/domain/enums";
import { ApiError } from "@/lib/errors";
import { submitJob } from "@/lib/jobs/dispatch";
import { sendRawWrite } from "@/lib/link/commands";
import { logger } from "@/lib/logger";
import { type CompileSettings, compile, readRequest } from "@/lib/markup/compiler";
import { globalLimits } from "@/lib/settings/settings-service";

/**
 * Server actions behind the Tools tab.
 *
 * Compiling happens here rather than in the browser, deliberately. A preview built from a second
 * implementation would agree with the real pipeline right up until it mattered, and the whole
 * value of a preview is that what it shows is what will print.
 */

/**
 * Rejects the call unless the request carries a valid administrator session.
 *
 * @throws ApiError when the caller is not signed in
 */
async function requireSession(): Promise<void> {
	if (!(await getCurrentSession())) {
		throw new ApiError("missing_key", "Not signed in.");
	}
}

/** One line as the paper preview renders it. */
export interface PreviewLine {
	spans: { text: string; bold: boolean; underline: number; invert: boolean; widthMult: number }[];
	align: "LEFT" | "CENTER" | "RIGHT";
	/** A directive-only line, drawn as a marker rather than as blank paper. */
	marker: string | null;
}

/** What compiling produced: paper, or the reason there is none. */
export interface PreviewResult {
	lines: PreviewLine[] | null;
	columns: number;
	error: { code: string; message: string; line?: number; column?: number } | null;
}

/**
 * Compiles markup for a device and returns what it would print.
 *
 * @param deviceId the device whose width and codepage to compile against
 * @param source the markup, one element per line
 * @returns the paper, or the first error with its position
 */
export async function preview(deviceId: string, source: string): Promise<PreviewResult> {
	try {
		await requireSession();

		const device = await prisma.device.findUnique({ where: { id: deviceId } });
		if (!device) {
			throw new ApiError("unknown_device", "That printer no longer exists.");
		}

		const settings: CompileSettings = {
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

		const body = { data: source.split("\n") };
		const request = readRequest(body, limits, settings);
		const job = compile("preview", device.name, request, limits, settings);

		return {
			columns: device.columns,
			error: null,
			lines: job.lines.map((line) => ({
				align: line.align,
				marker: describe(line.directives),
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
		if (error instanceof ApiError) {
			return {
				lines: null,
				columns: 0,
				error: {
					code: error.code,
					message: error.message,
					line: typeof error.details.line === "number" ? error.details.line : undefined,
					column: typeof error.details.column === "number" ? error.details.column : undefined,
				},
			};
		}
		logger.error("Preview failed", error);
		return {
			lines: null,
			columns: 0,
			error: { code: "internal_error", message: "Something went wrong. Check the server log." },
		};
	}
}

/** Describes a line's directives for the preview, or null when it has none. */
function describe(directives: { type: string; mode?: string; lines?: number }[]): string | null {
	if (directives.length === 0) {
		return null;
	}
	return directives
		.map((directive) =>
			directive.type === "CUT" ? `cut (${directive.mode?.toLowerCase()})` : `feed ${directive.lines}`,
		)
		.join(", ");
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
 * @returns the job id, or why it could not be printed
 */
export async function printMarkup(deviceId: string, source: string): Promise<SendResult> {
	try {
		await requireSession();
		const job = await submitJob(deviceId, { data: source.split("\n") });
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
	try {
		await requireSession();

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
