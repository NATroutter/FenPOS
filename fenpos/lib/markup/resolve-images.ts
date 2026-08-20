import "server-only";
import { remoteImageSize, storedImageSize } from "@/lib/assets/asset-service";
import { ApiError } from "@/lib/errors";
import type { ImageSource, ResolvedImages } from "@/lib/markup/images";
import { parseMarkup } from "@/lib/markup/parser";

/**
 * The pre-pass that turns every `<image>` reference in a request into a size the compiler can
 * charge for.
 *
 * **This exists because measuring an image is asynchronous and compiling is not.** A stored asset's
 * dimensions are a database row and a URL image's are an HTTP response, while `parseMarkup` takes a
 * string and `compile` returns a job — neither can wait for anything. Making them async would push
 * `await` through every caller of a pipeline that is otherwise a pure function of its input, for
 * the sake of one directive. So the waiting is done here, once, before the compile starts, and the
 * answers reach it through `CompileSettings.images`.
 *
 * Run it **before** compiling and after the request's own limits have been checked, so an oversized
 * body is refused without this server fetching anything on its behalf.
 *
 * **A URL image is fetched while the job compiles.** That is the accepted cost of the live-URL
 * option — an unreachable host makes the print fail, and a slow one makes the request wait, up to
 * `REMOTE_FETCH_TIMEOUT_MS` — and it is why stored assets are the documented default. What is
 * bounded here is how that cost grows: references are deduplicated, so a logo repeated on every
 * copy of a receipt is one fetch, and the fetches run together rather than in turn, so a receipt
 * naming several hosts waits for the slowest rather than for the sum. See {@link resolveImages}.
 */

/**
 * Resolves every image a request refers to.
 *
 * @param data the request's elements, exactly as the caller wrote them
 * @returns each reference in them, mapped to the image's own pixel dimensions
 * @throws ApiError if a reference names no stored image, or a URL cannot be fetched or read as
 *         one; the element it was written on travels in `details.line`
 */
export async function resolveImages(data: readonly string[]): Promise<ResolvedImages> {
	const references = collect(data);

	// Together rather than in turn. Each fetch carries its own deadline, so resolving five URLs
	// sequentially would let a receipt wait five times the timeout; this way it waits once. The
	// cost is that a receipt naming many distinct hosts opens that many connections at once, which
	// is bounded only by the request's own line limit.
	const sized = await Promise.all(
		[...references].map(async ([reference, line]) => [reference, await sizeOf(reference, line)] as const),
	);

	return new Map(sized);
}

/**
 * The two ways an `<image>` can open, matched case-insensitively as the tag registry resolves it.
 *
 * A tag's body runs to the next `>` and its name to the first `=`, so an image opens as exactly
 * `<image>` or `<image=…>` and nothing else — `<image ` is a tag called "image " and is refused as
 * unknown. Anything an element does not contain, it cannot produce.
 */
const IMAGE_OPENING = /<image[=>]/i;

/**
 * Finds every distinct image reference in a request, and where it was first written.
 *
 * Parses with the same parser the compile will use, so the references found here are exactly the
 * ones it will meet. An element that does not parse is skipped rather than reported: the compile
 * that follows raises that failure with a column, which is a better answer than anything this
 * function could say — and until then a receipt with a broken tag has caused no network traffic.
 *
 * Elements with no image tag in them are not parsed at all. Parsing is not free — a `<qr>` is
 * encoded while it is measured — and without this every job would be parsed twice for the sake of a
 * directive most receipts do not use. The scan is deliberately cruder than the parser and errs
 * towards parsing: it costs a wasted parse when a `<image=` turns out to be inside a QR payload,
 * and if it ever missed a real one the compile would fail loudly rather than print an image nothing
 * had charged for.
 *
 * @param data the request's elements
 * @returns each reference, mapped to the 1-based element it first appeared on
 */
function collect(data: readonly string[]): Map<string, number> {
	const references = new Map<string, number>();

	for (let index = 0; index < data.length; index++) {
		if (!IMAGE_OPENING.test(data[index])) {
			continue;
		}

		let directives: ReturnType<typeof parseMarkup>["directives"];
		try {
			directives = parseMarkup(data[index]).directives;
		} catch {
			continue;
		}

		for (const directive of directives) {
			if (directive.kind === "IMAGE" && !references.has(directive.ref)) {
				references.set(directive.ref, index + 1);
			}
		}
	}

	return references;
}

/**
 * Resolves one reference, whichever kind it is.
 *
 * A reference carrying a scheme is a URL; anything else is a stored asset's name. The test is the
 * scheme separator rather than an `http(s)` prefix on purpose, so that `ftp://…` is refused by the
 * fetch guard — which can say that only http and https are fetched — instead of being looked up as
 * an asset nobody would ever have named that way.
 *
 * @param reference the text between the tags
 * @param line the element it was written on
 * @returns the image's own pixel dimensions
 * @throws ApiError carrying the element, so a caller can find the tag that failed
 */
async function sizeOf(reference: string, line: number): Promise<ImageSource> {
	try {
		return reference.includes("://") ? await remoteImageSize(reference) : await storedImageSize(reference);
	} catch (thrown) {
		throw onLine(thrown, line);
	}
}

/**
 * Adds the element number to a refusal.
 *
 * The same thing the compiler's `translate` does for a positional parse failure, and for the same
 * reason: "there is no image called 'logo'" is a different message from "line 4 has no image called
 * 'logo'" to whoever has to fix the receipt. There is no column to add — the reference is the whole
 * of the block's content, and the tag it belongs to is the only one on its element.
 *
 * Anything that is not an `ApiError` is a fault on this side and is rethrown untouched, so it stays
 * a 500 and stays visible.
 *
 * @param thrown whatever the lookup raised
 * @param line the element the reference was written on
 * @returns the error to throw
 */
function onLine(thrown: unknown, line: number): unknown {
	if (!(thrown instanceof ApiError)) {
		return thrown;
	}
	return new ApiError(thrown.code, thrown.message, { ...thrown.details, line }, { cause: thrown });
}
