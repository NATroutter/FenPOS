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
 * copy of a receipt is one fetch; they are resolved several at a time, so a receipt naming a few
 * hosts waits for the slowest rather than for the sum; never more than {@link RESOLVE_WINDOW} at a
 * time, so what one request can make this server hold is a constant rather than a multiple of how
 * many URLs it chose to name; and never more than {@link MAX_REMOTE_IMAGES} of them at all, which
 * is what turns the waiting into a number too.
 */

/**
 * How many images may be resolved at once.
 *
 * **This is a bound on what a single request can make this server do, and it is the reason the
 * parallelism above is safe.** A request may carry up to `maxLines` elements — 200 by default — so
 * resolving every reference together let one authenticated caller open 200 sockets, hold 200 buffers
 * of up to `MAX_REMOTE_IMAGE_BYTES` each before anything was decoded, and pay 200 TLS handshakes,
 * since `pinnedTransport` deliberately pools no connections. Six holds the same shape at a constant
 * cost: at most six sockets and about twelve megabytes in flight, whatever the receipt says.
 *
 * Six rather than one, because resolving in turn is what the parallelism was for: a receipt naming
 * three hosts should wait once, not three times. Six rather than sixty, because a receipt with more
 * than a handful of *distinct* images is already unusual — a logo repeated on every copy is one
 * entry — so the window is only reached by receipts that are pathological or hostile, and those are
 * exactly the ones that should be made to queue.
 *
 * The honest cost: a receipt naming many distinct *working* slow hosts now waits
 * `ceil(count / 6)` timeouts instead of one. A hostile receipt does not, because the first refusal
 * stops the rest — see {@link resolveImages} — so the tail belongs to receipts that are succeeding.
 *
 * Stored assets pass through the same window and are unaffected by it in any measurable way: they
 * are local reads of two integer columns, holding no socket and no buffer.
 */
export const RESOLVE_WINDOW = 6;

/**
 * How many distinct images one request may name by URL.
 *
 * **The window bounds what this server holds; this bounds how long it waits.** They are different
 * exposures and neither implies the other. With the window alone, a receipt naming enough URLs still
 * waits one `REMOTE_FETCH_TIMEOUT_MS` per windowful — at the default line limit of 200 that is 34
 * windows, over a minute of a request-handling slot held by one caller. Capping the references is
 * what makes that a number: at most `ceil(12 / 6) = 2` windows, so six seconds, and a caller who
 * writes a thirteenth URL is told so immediately instead of waiting to find out.
 *
 * Twelve, for three reasons. It is two whole windows, so the bound divides evenly and raising it by
 * six is visibly another three seconds. It is far above any real receipt — the spec makes stored
 * assets the default and URLs the escape hatch, and a repeated logo is one reference after
 * deduplication — so nothing legitimate meets it. And it is deliberately *above*
 * {@link RESOLVE_WINDOW} rather than equal to it: were the two the same, every permitted receipt
 * would fit in one window and there would be no observable difference between windowing and not,
 * which would quietly cost the concurrency bound its test.
 *
 * **Remote references only.** A stored asset is a local read of two integer columns — no socket, no
 * buffer, no timeout to wait out — so counting them here would cap the thing this system asks people
 * to use in place of URLs.
 *
 * A wall-clock budget was the alternative and is worse. Bounding the wait honestly means cancelling
 * the fetches still in flight, which needs an `AbortController` threaded through every worker; a
 * budget that merely stops waiting leaves those fetches running, still holding sockets and still
 * burning CPU, after the caller has already been answered. That is a leak wearing the costume of a
 * limit. Refusing up front costs nothing and cannot leak.
 */
export const MAX_REMOTE_IMAGES = 12;

/**
 * Resolves every image a request refers to.
 *
 * @param data the request's elements, exactly as the caller wrote them
 * @returns each reference in them, mapped to the image's own pixel dimensions
 * @throws ApiError if the request names more than {@link MAX_REMOTE_IMAGES} URLs, if a reference
 *         names no stored image, or if a URL cannot be fetched or read as one; for the last two the
 *         element it was written on travels in `details.line`
 */
export async function resolveImages(data: readonly string[]): Promise<ResolvedImages> {
	const queue = [...collect(data)];
	requireWithinRemoteLimit(queue);

	const sized = new Map<string, ImageSource>();

	// A fixed set of workers sharing one queue, rather than one promise per reference: that is what
	// makes {@link RESOLVE_WINDOW} the number in flight rather than merely the number started.
	let refused = false;
	const workers = Array.from({ length: Math.min(RESOLVE_WINDOW, queue.length) }, async () => {
		for (let entry = queue.shift(); entry !== undefined && !refused; entry = queue.shift()) {
			const [reference, line] = entry;
			try {
				sized.set(reference, await sizeOf(reference, line));
			} catch (thrown) {
				// The whole request is going to be refused for this, so the rest of the receipt is
				// work nobody will read. Stopping matters most for the case that matters most: a
				// receipt full of unreachable hosts costs one window of timeouts, not all of them.
				refused = true;
				throw thrown;
			}
		}
	});

	// Rejects with the first refusal, which is the one reported — first in time among the workers
	// running together, not necessarily first in the receipt. Any of them is a refusal of the whole
	// request and each names its own element, so which one arrives first changes the message and
	// nothing else. The others are still awaited here, so a worker that fails on its way out cannot
	// become an unhandled rejection.
	await Promise.all(workers);

	return sized;
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
 * Whether a reference names somewhere to fetch from rather than something already stored.
 *
 * The test is the scheme separator rather than an `http(s)` prefix on purpose, so that `ftp://…` is
 * refused by the fetch guard — which can say that only http and https are fetched — instead of being
 * looked up as an asset nobody would ever have named that way. It also means a reference this
 * function calls remote is one the remote limit counts, even if the fetch will go on to reject it:
 * the limit is about how much of this work a request may ask for, not about how much succeeds.
 *
 * @param reference the text between the tags
 * @returns true when resolving it means going to the network
 */
function isRemote(reference: string): boolean {
	return reference.includes("://");
}

/**
 * Refuses a request naming more URLs than {@link MAX_REMOTE_IMAGES}.
 *
 * Runs before the workers start, which is the whole of its value: a limit enforced after the fetches
 * were away would report the problem while still causing it.
 *
 * Raised as a request-level {@link ApiError} rather than a positioned `MarkupError`, because that is
 * what it is. The count is of *distinct* references across every element, so no single tag is at
 * fault — the one that crosses the line is merely the last one written, and pointing a column at it
 * would name an innocent tag. Same reasoning the compiler already applies to `too_many_lines` and
 * `text_too_large`, which are also whole-request refusals with no line to report.
 *
 * @param references every reference the request names, deduplicated
 * @throws ApiError if too many of them are URLs
 */
function requireWithinRemoteLimit(references: readonly (readonly [string, number])[]): void {
	const remote = references.filter(([reference]) => isRemote(reference)).length;
	if (remote > MAX_REMOTE_IMAGES) {
		throw new ApiError(
			"too_many_remote_images",
			`A receipt may name at most ${MAX_REMOTE_IMAGES} images by URL, and this one names ${remote}. Store them on the Assets tab and reference them by name instead.`,
			{ limit: MAX_REMOTE_IMAGES, seen: remote },
		);
	}
}

/**
 * Resolves one reference, whichever kind it is.
 *
 * @param reference the text between the tags
 * @param line the element it was written on
 * @returns the image's own pixel dimensions
 * @throws ApiError carrying the element, so a caller can find the tag that failed
 */
async function sizeOf(reference: string, line: number): Promise<ImageSource> {
	try {
		return isRemote(reference) ? await remoteImageSize(reference) : await storedImageSize(reference);
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
