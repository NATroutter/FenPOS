import { ApiError } from "@/lib/errors";

/**
 * Reading a request body bounded before it is parsed.
 *
 * Parsing is the work an oversized body is trying to provoke — `JSON.parse` over megabytes, or
 * worse, a base64 decode of them — so the size is checked against the caller's own ceiling first,
 * on the raw text, and only a body that passes is handed to the parser. A body refused for its
 * size costs one `Buffer.byteLength` call; nothing here reads it twice.
 *
 * Every route on this API that reads a JSON body from an untrusted caller goes through
 * {@link readBoundedJson} rather than restating the check: `print`, `preview`, and asset creation
 * today, with a raw-write endpoint to follow. One place for the bound and its wording means none
 * of them can drift out of step with the others.
 */

/**
 * Reads and parses a request's JSON body, refusing one over `maxBytes` before parsing it.
 *
 * @param request the incoming request
 * @param maxBytes the caller's own ceiling, in bytes. Deliberately required rather than
 *   defaulted — a shared default would be a size chosen for whichever body shape thought of it
 *   first, and every caller here has its own: print and preview bound a receipt, asset creation
 *   bounds a base64-encoded image wrapped in JSON.
 * @returns the parsed body, and the raw text it was parsed from — a caller that also needs to
 *   fingerprint the bytes as they arrived (see `bodyHash` in `lib/jobs/idempotency.ts`) does not
 *   have to re-serialise the parsed value to get them back
 * @throws ApiError `body_too_large` if the body is over `maxBytes`; `invalid_json` if it does not
 *   parse
 */
export async function readBoundedJson(request: Request, maxBytes: number): Promise<{ body: unknown; raw: string }> {
	const raw = await request.text();

	if (Buffer.byteLength(raw, "utf8") > maxBytes) {
		throw new ApiError("body_too_large", `Request body must be under ${maxBytes} bytes.`);
	}

	try {
		return { body: JSON.parse(raw), raw };
	} catch {
		throw new ApiError("invalid_json", "Body is not valid JSON");
	}
}

/**
 * The body-size ceiling `print` and `preview` share.
 *
 * One constant rather than two copies of the literal. It had drifted into exactly that: preview
 * restated `64 * 1024` with a comment asserting it matched the print endpoint, and nothing but
 * that comment enforced the claim. A receipt is `data`, one markup element per line, plus an
 * optional `linefeed` — 64 KiB is far more than any receipt this system prints needs, and a body
 * approaching it is already not a receipt a thermal printer could use.
 */
export const PRINT_REQUEST_MAX_BODY_BYTES = 64 * 1024;
