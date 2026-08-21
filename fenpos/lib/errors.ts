import { logger } from "@/lib/logger";

/**
 * The public API error contract.
 *
 * Every non-2xx response shares one shape. Clients branch on `error` alone; `message` is
 * for humans and is explicitly not part of the contract, so its wording may change without
 * being a breaking change. Additional fields carry machine-usable detail — a codepage
 * rejection names the exact line, column, and character rather than making the caller guess.
 *
 * **The status is derived from the code, and groups codes by what the caller must do about
 * them.** It is therefore a summary of the code rather than a second contract beside it: a code
 * may be re-bucketed when the grouping is sharpened, as the content errors were when they moved
 * off `400`. That is precisely why `error` is the field to branch on and the status is not.
 *
 * This contract is inherited from the single-machine daemon and preserved deliberately:
 * existing POS clients already branch on these codes.
 */

/**
 * Every error code the API may return.
 *
 * Codes are stable identifiers. Removing or renaming one is a breaking change for clients;
 * adding one is not.
 */
export const API_ERROR_STATUS = {
	/**
	 * 400: the request could not be read.
	 *
	 * The envelope is wrong — not JSON, or not the shape this endpoint accepts. Nothing was
	 * interpreted as a receipt, which is why nothing in this group carries a line or a column: there
	 * is no position to name. The caller fixes their request, not their markup.
	 */
	invalid_json: 400,
	missing_field: 400,
	invalid_type: 400,
	invalid_linefeed: 400,
	unknown_field: 400,

	// --- 401: the caller is not identified ---
	missing_key: 401,
	invalid_key: 401,

	/**
	 * 403: the caller is identified but lacks the permission for this action.
	 *
	 * Note that a key addressing a device it has no grant for gets `unknown_device` (404)
	 * instead, so that device names cannot be enumerated by probing for the difference
	 * between "exists but forbidden" and "does not exist".
	 */
	insufficient_permission: 403,

	// --- 404: no such resource, or none this caller may see ---
	unknown_agent: 404,
	unknown_device: 404,
	unknown_job: 404,
	/** An `<image>` tag, or the Assets tab, naming a stored image that is not there. */
	unknown_asset: 404,

	// --- 409: the resource is in the wrong state for this action ---
	job_not_cancellable: 409,
	/** A agent or device name is already in use. Names are unique by design, not by accident. */
	name_taken: 409,
	/** Reissuing a pairing code for a agent that already holds a credential. */
	agent_already_paired: 409,

	/**
	 * 413: there is too much of it.
	 *
	 * Well-formed, printable, and over a limit. Every code here has the same remedy — send less —
	 * which is why they share a status with `body_too_large` rather than sitting among the content
	 * errors a caller fixes by rewriting markup.
	 *
	 * Some are measured on the request as it arrives and some on what it compiles to. That
	 * distinction is real, and it is deliberately not given its own status: a caller cannot tell
	 * which side of it their receipt fell on, so a status encoding it would be precision they
	 * cannot act on.
	 */
	body_too_large: 413,
	too_many_lines: 413,
	line_too_long: 413,
	text_too_large: 413,
	too_many_output_lines: 413,
	/**
	 * A receipt naming more images by URL than one request may fetch.
	 *
	 * A limit on the request as a whole rather than on any one tag: it counts the distinct URLs
	 * across every element, so the tag that crosses the line is only the last one written rather
	 * than the one at fault. See `MAX_REMOTE_IMAGES` in `lib/markup/resolve-images.ts` for what the
	 * number bounds.
	 */
	too_many_remote_images: 413,
	/**
	 * A receipt whose images come to more dots than one job can carry.
	 *
	 * Only dots that must travel inside the job are counted — a URL image, or a stored one printed
	 * at a width the agent was not synced at. A stored image at the paper's own width costs nothing
	 * against this, because its dots reached the agent with the printer's configuration. See
	 * `MAX_INLINE_IMAGE_CHARS` in `lib/markup/resolve-images.ts`.
	 */
	image_too_large: 413,
	/**
	 * A receipt that compiled but is too large to hand to a printer in one message.
	 *
	 * The backstop behind every content limit rather than one of them. `maxTotalChars` is
	 * operator-configurable up to a million characters, so an install that raises it can write a
	 * receipt that passes every check and still exceeds `MAX_FRAME_BYTES` once compiled — and an
	 * agent sent an oversized frame closes the link, taking its printers offline. Refused at
	 * submission instead.
	 */
	job_too_large: 413,

	invalid_content_type: 415,

	/**
	 * 422: the request was read, and the receipt it describes cannot be printed.
	 *
	 * The content is the problem rather than the envelope, so these are the codes that carry a
	 * position — a `line`, and usually a `column` — and the caller fixes their markup rather than
	 * their request. A character the codepage cannot represent adds `character` and `codepage`
	 * beside them.
	 */
	control_character: 422,
	unknown_tag: 422,
	unclosed_tag: 422,
	unexpected_close_tag: 422,
	invalid_tag_argument: 422,
	invalid_align_scope: 422,
	invalid_wrap_scope: 422,
	invalid_rule_scope: 422,
	invalid_block_scope: 422,
	unsupported_character: 422,
	/**
	 * A `<qr>`, `<barcode>` or `<pdf417>` measured wider than the device's paper.
	 *
	 * Refused at compile time rather than printed clipped. A symbol wider than the head has bars
	 * missing off the right edge, and a barcode with bars missing is not a narrower barcode — it is
	 * one that will not scan, discovered by whoever is holding the receipt.
	 *
	 * Not `413`: the remedy is a smaller module size or a different symbology, not less content.
	 */
	symbol_too_wide: 422,
	/**
	 * An `<image>` naming the application's own logo at a width nothing was bundled for.
	 *
	 * The logo is not an asset and is not scaled: the agent holds one raster per bundled paper
	 * width and `BundledImages` matches a width exactly, so a device on some other paper — or a
	 * `<image=50>` asking for half of one — names dots that do not exist on either side. The panel
	 * could dither any width and deliberately does not, since a preview of something no printer can
	 * produce is worse than a refusal. See `BUNDLED_LOGO_WIDTHS` in `lib/assets/bundled-logo.ts`.
	 */
	unbundled_logo_width: 422,

	/** 429: too many attempts. Applied to sign-in and to agent pairing. */
	rate_limited: 429,

	/** 500: an unexpected server fault. Details are logged, never returned. */
	internal_error: 500,

	// --- 503: the target cannot accept work right now ---
	agent_offline: 503,
	device_unavailable: 503,
	device_paused: 503,
	queue_full: 503,
} as const;

export type ApiErrorCode = keyof typeof API_ERROR_STATUS;

/** Extra machine-usable fields carried alongside an error code. */
export type ApiErrorDetails = Record<string, unknown>;

/** The JSON body returned for any non-2xx response. */
export interface ApiErrorBody extends ApiErrorDetails {
	/** Stable machine-readable code. The only field clients should branch on. */
	error: ApiErrorCode;
	/** Human-readable explanation. Not part of the contract. */
	message: string;
}

/**
 * An error that maps onto the public API contract.
 *
 * Thrown anywhere in a request path and converted to a response at the boundary, so that
 * handlers describe what went wrong without also deciding how to serialise it.
 */
export class ApiError extends Error {
	/** Stable machine-readable code, which also determines the HTTP status. */
	readonly code: ApiErrorCode;

	/** HTTP status derived from the code. */
	readonly status: number;

	/** Additional machine-usable fields merged into the response body. */
	readonly details: ApiErrorDetails;

	/**
	 * @param code the stable error code, which determines the HTTP status
	 * @param message human-readable explanation, safe to expose to the caller
	 * @param details additional fields to merge into the body, e.g. line and column
	 * @param options standard error options, used to preserve an underlying cause
	 */
	constructor(code: ApiErrorCode, message: string, details: ApiErrorDetails = {}, options?: ErrorOptions) {
		super(message, options);
		this.name = "ApiError";
		this.code = code;
		this.status = API_ERROR_STATUS[code];
		this.details = details;
	}

	/**
	 * Serialises this error into the contract shape.
	 *
	 * @returns the response body
	 */
	toBody(): ApiErrorBody {
		return { ...this.details, error: this.code, message: this.message };
	}

	/**
	 * Builds the HTTP response for this error.
	 *
	 * @returns a JSON response carrying the contract body and the mapped status
	 */
	toResponse(): Response {
		return Response.json(this.toBody(), { status: this.status });
	}
}

/**
 * Converts any thrown value into a contract-shaped response.
 *
 * An `ApiError` is returned as-is because it was raised deliberately and its message was
 * written to be seen. Anything else is an unexpected fault: it is logged in full and
 * reported as a bare `internal_error`, so that stack traces and internal identifiers never
 * reach a caller.
 *
 * @param error the caught value
 * @param context request context to attach to the log line for unexpected faults
 * @returns a JSON response conforming to the error contract
 */
export function toErrorResponse(error: unknown, context?: Record<string, unknown>): Response {
	if (error instanceof ApiError) {
		return error.toResponse();
	}

	logger.error("Unhandled error while serving a request", error, context);

	return Response.json(
		{ error: "internal_error", message: "The server failed to handle this request." },
		{ status: 500 },
	);
}
