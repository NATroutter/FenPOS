import { ApiError } from "@/lib/errors";

/**
 * Reading a request body bounded before it is parsed.
 *
 * Parsing is the work an oversized body is trying to provoke — `JSON.parse` over megabytes, or
 * worse, a base64 decode of them — so the size is enforced first and only a body that passes is
 * handed to the parser.
 *
 * **Enforced on the way in, not after.** This used to `await request.text()` and then measure what
 * came back, which refused the right requests and paid the whole cost of the wrong ones first: a
 * 64 MiB body was received in full and materialised as a string before the comparison that rejected
 * it, so the refusal cost the server 64 MiB and the caller one request. Four of those concurrently
 * moved the process's resident memory by a quarter of a gigabyte, against a container limited to
 * 1 GiB. Now the declared length is checked before a byte is read, and the read itself stops at the
 * cap — so a refusal costs at most `maxBytes` however the body was framed, and usually nothing at
 * all.
 *
 * Every route on this API that reads a JSON body from an untrusted caller goes through
 * {@link readBoundedJson} rather than restating the check: print, preview, asset creation, and
 * the raw write. One place for the bound and its wording means none of them can drift out of step
 * with the others.
 */

/**
 * Reads a request's body as text, refusing one over `maxBytes` without buffering it.
 *
 * Two gates, because a body arrives two ways. A declared `Content-Length` is checked before the
 * stream is touched, which is the common case and costs nothing. A body framed without one —
 * `Transfer-Encoding: chunked` — has no length to check, so the read counts as it goes and abandons
 * the stream the moment the cap is passed; the caller may still have more to send, but this side
 * has stopped holding it.
 *
 * @param request the incoming request
 * @param maxBytes the caller's own ceiling, in bytes
 * @param message what to say when it is exceeded, in the caller's own words
 * @returns the body as text
 * @throws ApiError `body_too_large` when the body is over `maxBytes`
 */
export async function readBoundedText(request: Request, maxBytes: number, message: string): Promise<string> {
	const declared = request.headers.get("content-length");
	if (declared !== null) {
		const length = Number(declared);
		// A malformed header is treated as no header rather than as a refusal: the streaming count
		// below is the real bound, and this one is an optimisation that happens to also be a defence.
		if (Number.isFinite(length) && length > maxBytes) {
			throw new ApiError("body_too_large", message);
		}
	}

	const body = request.body;
	if (body === null) {
		return "";
	}

	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;

	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}

		total += value.byteLength;
		if (total > maxBytes) {
			// Cancelled rather than left to drain: the point of stopping here is that the rest of the
			// body is never held, and a reader that stays open goes on being fed.
			await reader.cancel().catch(() => undefined);
			throw new ApiError("body_too_large", message);
		}
		chunks.push(value);
	}

	return Buffer.concat(chunks).toString("utf8");
}

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
	const raw = await readBoundedText(request, maxBytes, `Request body must be under ${maxBytes} bytes.`);

	try {
		return { body: JSON.parse(raw), raw };
	} catch {
		throw new ApiError("invalid_json", "Body is not valid JSON");
	}
}

/**
 * The body-size ceiling print and preview share.
 *
 * One constant rather than two copies of the literal. It had drifted into exactly that: preview
 * restated `64 * 1024` with a comment asserting it matched the print endpoint, and nothing but
 * that comment enforced the claim. A receipt is `data`, one markup element per line, plus an
 * optional `linefeed` — 64 KiB is far more than any receipt this system prints needs, and a body
 * approaching it is already not a receipt a thermal printer could use.
 */
export const PRINT_REQUEST_MAX_BODY_BYTES = 64 * 1024;
