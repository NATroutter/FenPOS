import "server-only";
import { rasterFor, remoteImage, storedImageSize } from "@/lib/assets/asset-service";
import { BUNDLED_LOGO_NAME, bundledLogoRaster, bundledLogoSize, isBundledLogo } from "@/lib/assets/bundled-logo";
import { ditherToRaster, type ImageRaster } from "@/lib/assets/dither";
import { ApiError } from "@/lib/errors";
import { IMAGE_LIMITS, MAX_FRAME_BYTES } from "@/lib/link/protocol";
import { dotWidth } from "@/lib/markup/blocks";
import { type ImageSource, printedWidthDots, type ResolvedImages } from "@/lib/markup/images";
import { parseMarkup } from "@/lib/markup/parser";
import { integerSetting } from "@/lib/settings/settings-service";

/**
 * The pre-pass that turns every `<image>` reference in a request into a size the compiler can
 * charge for, and into the dots that have to travel with the job.
 *
 * **This exists because measuring an image is asynchronous and compiling is not.** A stored asset's
 * dimensions are a database row and a URL image's are an HTTP response, while `parseMarkup` takes a
 * string and `compile` returns a job — neither can wait for anything. Making them async would push
 * `await` through every caller of a pipeline that is otherwise a pure function of its input, for
 * the sake of one directive. So the waiting is done here, once, before the compile starts, and the
 * answers reach it through `CompileSettings.images`.
 *
 * Dithering is here for exactly the same reason and is the second thing this pre-pass owns. A stored
 * asset printed at the paper's own width needs none: its dots reached the agent with the device
 * configuration, and the job names them. Everything else — a URL, or a stored asset at some other
 * printed width — has its raster produced here, because `ditherToRaster` is asynchronous too and the
 * compiler that must emit those dots is not.
 *
 * Run it **before** compiling and after the request's own limits have been checked, so an oversized
 * body is refused without this server fetching anything on its behalf.
 *
 * **A URL image is fetched while the job compiles.** That is the accepted cost of the live-URL
 * option — an unreachable host makes the print fail, and a slow one makes the request wait, up to
 * the configured `images.remoteFetchTimeoutMs` — and it is why stored assets are the documented
 * default. What is bounded here is how that cost grows: references are deduplicated, so a logo
 * repeated on every copy of a receipt is one fetch; they are resolved several at a time, so a receipt
 * naming a few hosts waits for the slowest rather than for the sum; never more than
 * {@link RESOLVE_WINDOW} at a time, so what one request can make this server hold is a constant
 * rather than a multiple of how many URLs it chose to name; and never more than
 * {@link maxRemoteReferences} of them at all, which is what turns the waiting into a number too.
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
 * How many distinct images one request may name by URL, read from the `images.maxRemoteReferences`
 * setting.
 *
 * **The window bounds what this server holds; this bounds how long it waits.** They are different
 * exposures and neither implies the other. With the window alone, a receipt naming enough URLs still
 * waits one remote fetch timeout per windowful — at the default line limit of 200 that is 34 windows,
 * over a minute of a request-handling slot held by one caller. Capping the references is what makes
 * that a number: at the default of twelve, at most `ceil(12 / 6) = 2` windows, so a bounded few
 * seconds, and a caller who writes a thirteenth URL is told so immediately instead of waiting to find
 * out.
 *
 * Twelve is the fallback, for three reasons. It is two whole windows, so the bound divides evenly and
 * raising it by six is visibly another window's wait. It is far above any real receipt — the spec
 * makes stored assets the default and URLs the escape hatch, and a repeated logo is one reference
 * after deduplication — so nothing legitimate meets it. And it is deliberately *above*
 * {@link RESOLVE_WINDOW} rather than equal to it: were the two the same, every permitted receipt
 * would fit in one window and there would be no observable difference between windowing and not,
 * which would quietly cost the concurrency bound its test.
 *
 * **An operator may set it to 0.** That is not an edge case of the limit — it is the limit turned
 * into a switch, and the one deliberate way to take outbound image fetching off an install entirely.
 * {@link requireWithinRemoteLimit} gives that case its own refusal, because "you may reference at
 * most 0 images" reads as a bug report, not as a security posture someone chose.
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
 *
 * @returns the configured limit
 */
export async function maxRemoteReferences(): Promise<number> {
	return await integerSetting("images.maxRemoteReferences");
}

/**
 * How many base64 characters of image dots one request may put inside its job.
 *
 * **A bound on the frame, not on the picture.** A job is one WebSocket message and is refused whole
 * above {@link MAX_FRAME_BYTES}, so dots that ride inside it spend from an allowance the receipt's
 * text also draws on. Without this, a receipt naming a few tall images compiles cleanly, is recorded
 * as a job, and then cannot be sent — a 500 for something that was a property of the request all
 * along, and a job left claiming to be queued.
 *
 * Three quarters of the frame, leaving 64 KB for the text and structure around them: four times the
 * default `maxTotalChars`, and comfortably more than any receipt that also carries this many dots.
 * It sits above `IMAGE_LIMITS.maxRasterChars`, the wire's cap on any single raster, on purpose: one
 * image may spend two thirds of the allowance and several must share it, and the whole is wide
 * enough that the default ceiling of {@link maxRemoteReferences} distinct URL logos still prints
 * rather than being refused by an allowance narrower than the limit beside it.
 *
 * **Stored images at the paper's own width cost nothing here.** Their dots are already on the agent,
 * so a receipt built the way this system asks — a stored logo, printed full width — never meets this
 * limit however many times it repeats.
 */
export const MAX_INLINE_IMAGE_CHARS = MAX_FRAME_BYTES - 64 * 1024;

/**
 * Resolves every image a request refers to.
 *
 * @param data the request's elements, exactly as the caller wrote them
 * @param columns the target device's width in printer columns, which decides both the paper width
 *        a stored raster was synced at and the dot widths the tags ask for
 * @returns each reference in them, mapped to the image's own pixel dimensions and to any dots that
 *          must travel inside the job
 * @throws ApiError if the request names more remote URLs than {@link maxRemoteReferences} allows —
 *         or, when that setting is 0, if it names any at all — if its images come to more than
 *         {@link MAX_INLINE_IMAGE_CHARS}, if a reference names no stored image, or if a URL cannot be
 *         fetched or read as one; for the last two the element it was written on travels in
 *         `details.line`
 */
export async function resolveImages(data: readonly string[], columns: number): Promise<ResolvedImages> {
	const queue = [...collect(data, columns)];
	await requireWithinRemoteLimit(queue);

	const sized = new Map<string, ImageSource>();
	const budget = { spent: 0 };

	// A fixed set of workers sharing one queue, rather than one promise per reference: that is what
	// makes {@link RESOLVE_WINDOW} the number in flight rather than merely the number started.
	let refused = false;
	const workers = Array.from({ length: Math.min(RESOLVE_WINDOW, queue.length) }, async () => {
		for (let entry = queue.shift(); entry !== undefined && !refused; entry = queue.shift()) {
			const [reference, use] = entry;
			try {
				sized.set(reference, await resolveOne(reference, use, columns, budget));
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
 * How one request uses one image.
 *
 * The widths are what makes this more than a line number. A raster is dithered for one printed
 * width, so a receipt writing `<image>logo</image>` and `<image=50>logo</image>` needs two — while
 * still needing only one lookup or one fetch, because an image's own dimensions do not depend on how
 * wide it is printed. Held as a set so a logo repeated on every copy of a receipt is dithered once.
 */
interface ImageUse {
	/** The 1-based element the reference first appeared on, for naming it in a refusal. */
	line: number;
	/** Every distinct printed width, in dots, this request asks for. */
	widths: Set<number>;
}

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
 * @param columns the target device's width in printer columns
 * @returns each reference, mapped to how the request uses it
 */
function collect(data: readonly string[], columns: number): Map<string, ImageUse> {
	const references = new Map<string, ImageUse>();

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
			if (directive.kind !== "IMAGE") {
				continue;
			}
			let use = references.get(directive.ref);
			if (!use) {
				use = { line: index + 1, widths: new Set() };
				references.set(directive.ref, use);
			}
			use.widths.add(printedWidthDots(directive.widthPercent, columns));
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
 * Refuses a request naming more URLs than {@link maxRemoteReferences} allows.
 *
 * Runs before the workers start, which is the whole of its value: a limit enforced after the fetches
 * were away would report the problem while still causing it.
 *
 * The setting is read only when the receipt actually names a remote reference. Most jobs name none at
 * all, and there is no reason for those to pay for a settings read that can only ever pass.
 *
 * Raised as a request-level {@link ApiError} rather than a positioned `MarkupError`, because that is
 * what it is. The count is of *distinct* references across every element, so no single tag is at
 * fault — the one that crosses the line is merely the last one written, and pointing a column at it
 * would name an innocent tag. Same reasoning the compiler already applies to `too_many_lines` and
 * `text_too_large`, which are also whole-request refusals with no line to report.
 *
 * **Zero is a switch, not merely a small limit.** An operator may set `images.maxRemoteReferences` to
 * 0 to turn outbound image fetching off entirely — a security posture, not an edge case — so a
 * receipt naming even one URL is refused with a message saying URL images are switched off on this
 * install. "You may reference at most 0 images" would read as this server being broken rather than as
 * a choice someone made.
 *
 * @param references every reference the request names, deduplicated
 * @throws ApiError if too many of them are URLs, or if any of them is a URL while the limit is 0
 */
async function requireWithinRemoteLimit(references: readonly (readonly [string, ImageUse])[]): Promise<void> {
	const remote = references.filter(([reference]) => isRemote(reference)).length;
	if (remote === 0) {
		return;
	}

	const limit = await maxRemoteReferences();
	if (limit === 0) {
		throw new ApiError(
			"too_many_remote_images",
			"This install has switched off images fetched by URL. Store the image on the Assets tab and reference it by name instead.",
			{ limit: 0, seen: remote },
		);
	}
	if (remote > limit) {
		throw new ApiError(
			"too_many_remote_images",
			`A receipt may name at most ${limit} images by URL, and this one names ${remote}. Store them on the Assets tab and reference them by name instead.`,
			{ limit, seen: remote },
		);
	}
}

/**
 * Resolves one reference, whichever kind it is.
 *
 * @param reference the text between the tags
 * @param use the element it was written on and the widths the request prints it at
 * @param columns the target device's width in printer columns
 * @returns the image's own pixel dimensions, and any dots that must travel inside the job
 * @throws ApiError carrying the element, so a caller can find the tag that failed
 */
async function resolveOne(
	reference: string,
	use: ImageUse,
	columns: number,
	budget: InlineBudget,
): Promise<ImageSource> {
	try {
		if (isRemote(reference)) {
			return await resolveRemote(reference, use.widths, budget);
		}
		// Before the asset lookup, and that order is the guarantee rather than a convenience. The
		// name is refused at creation, so no row should exist under it — but one committed before
		// the reservation existed still could, and if it were consulted first the test page would
		// quietly print somebody's picture instead of the application's logo.
		if (isBundledLogo(reference)) {
			return await resolveBundledLogo(use.widths, budget);
		}
		return await resolveStored(reference, use.widths, columns, budget);
	} catch (thrown) {
		throw onLine(thrown, use.line);
	}
}

/**
 * Resolves the application's own logo, which is a file on this server rather than a row or a URL.
 *
 * **Its dots always travel with the job, at every width including the paper's own.** A stored asset
 * at the paper width answers with a REF because its dots were pushed to the agent with the device's
 * configuration; the logo's were not — the agent's copy came from its own jar, dithered whenever
 * that jar was built. A REF would therefore print *the agent's* logo while the preview showed the
 * panel's, and a panel and an agent updated at different times would differ with nothing on either
 * side to say so. Inline costs one raster in the frame and makes the paper show what was previewed.
 * The agent's bundle keeps its purpose: it is what `device.test` composes from, on the agent, with
 * no panel involved.
 *
 * @param widths every printed width, in dots, this request needs
 * @param budget what the request has spent of its inline allowance
 * @returns the logo's own dimensions and a raster per width
 * @throws ApiError if a width is one the agent bundles nothing for, or the dots take the request
 *         past {@link MAX_INLINE_IMAGE_CHARS}
 */
async function resolveBundledLogo(widths: ReadonlySet<number>, budget: InlineBudget): Promise<ImageSource> {
	const size = await bundledLogoSize();

	const inline = new Map<number, ImageRaster>();
	for (const width of widths) {
		const raster = await bundledLogoRaster(width);
		charge(BUNDLED_LOGO_NAME, raster, budget);
		inline.set(width, raster);
	}

	return { width: size.width, height: size.height, inline };
}

/**
 * What one request has spent of {@link MAX_INLINE_IMAGE_CHARS} so far.
 *
 * Mutable and shared across the workers, which is safe because they interleave rather than run in
 * parallel — one thread, so no two of them are ever between reading and writing this at once.
 */
interface InlineBudget {
	spent: number;
}

/**
 * Charges a raster against the request's allowance, refusing it if the job could not carry it.
 *
 * Charged as it is produced rather than totted up at the end, so a receipt asking for far too much
 * stops at the first image past the line instead of dithering the rest of them first.
 *
 * **Two limits, and both have to be checked here.** The request budget below is one of them; the
 * other is `IMAGE_LIMITS.maxRasterChars`, which bounds any *single* raster and which
 * `imageSourceSchema` and the agent's `FrameCodec.readRaster` both enforce. This function used to
 * check only the first, and the gap between them is real: a 576x1500 inline raster is inside the
 * 192 KB request allowance and past the 128 KB per-raster cap, so it compiled, was recorded as a
 * job, and then failed serialisation with a `ZodError` — which `dispatch` did not recognise, so the
 * caller got a 500 and the job sat QUEUED forever. The sync path already checked each raster
 * against `assetRasterSchema` before adding it; the job path did not.
 *
 * @param reference the image, for the message
 * @param raster the dots just produced
 * @param budget what the request has spent so far, updated in place
 * @throws ApiError when this raster is larger than the wire will carry, or takes the request past
 *         its allowance
 */
function charge(reference: string, raster: ImageRaster, budget: InlineBudget): void {
	const chars = Math.ceil(raster.packed.length / 3) * 4;
	if (chars > IMAGE_LIMITS.maxRasterChars) {
		throw new ApiError(
			"image_too_large",
			`'${reference}' is ${raster.widthDots}x${raster.heightDots} dots, more than a single image may carry in a job. Print it smaller, or store it on the Assets tab and print it at the paper's full width so its dots travel with the printer's configuration instead.`,
			{ limit: IMAGE_LIMITS.maxRasterChars, chars },
		);
	}

	budget.spent += chars;
	if (budget.spent > MAX_INLINE_IMAGE_CHARS) {
		throw new ApiError(
			"image_too_large",
			`The images this receipt has to send come to more than a job can carry. '${reference}' is ${raster.widthDots}x${raster.heightDots} dots; print it smaller, or store it on the Assets tab and print it at the paper's full width so its dots travel with the printer's configuration instead.`,
			{ limit: MAX_INLINE_IMAGE_CHARS, spent: budget.spent },
		);
	}
}

/**
 * Resolves a URL image, whose dots can never have been pre-synced.
 *
 * One fetch answers both questions. The bytes measure the image and then dither it at every width
 * the receipt prints it at, and are dropped as soon as that is done — an earlier version measured
 * from one fetch and left the pixels to a second, so printing a URL image went to the same host
 * twice.
 *
 * @param url the URL, exactly as it was written between the tags
 * @param widths every printed width, in dots, this request needs
 * @param budget what the request has spent of its inline allowance
 * @returns the image's own dimensions and a raster per width
 * @throws ApiError if the fetch is refused, the bytes are not an image this pipeline prints, or the
 *         dots take the request past {@link MAX_INLINE_IMAGE_CHARS}
 */
async function resolveRemote(url: string, widths: ReadonlySet<number>, budget: InlineBudget): Promise<ImageSource> {
	const fetched = await remoteImage(url);

	const inline = new Map<number, ImageRaster>();
	for (const width of widths) {
		const raster = await ditherToRaster(fetched.bytes, width);
		charge(url, raster, budget);
		inline.set(width, raster);
	}

	return { width: fetched.width, height: fetched.height, inline };
}

/**
 * Resolves a stored asset, dithering only the widths the agent was not already sent.
 *
 * **The paper width is free and every other width is not.** A stored asset is dithered once per
 * paper width and pushed with the device configuration, so the common case — a logo at the full
 * width of the paper — needs nothing here beyond two integer columns. A tag asking for some other
 * width has no synced raster to name, and the alternative of shrinking one on the agent would
 * resample dots already reduced to black and white, so those dots are dithered here and ride in the
 * job like a URL's. That is the honest price of `<image=50>`, and it is paid on the print path.
 *
 * @param name the asset's name, as written between the tags
 * @param widths every printed width, in dots, this request needs
 * @param columns the device's width in printer columns, which fixes the width that was synced
 * @param budget what the request has spent of its inline allowance
 * @returns the image's stored dimensions and a raster for each width that must travel
 * @throws ApiError if no image of that name is stored, or the dots it needs take the request past
 *         {@link MAX_INLINE_IMAGE_CHARS}
 */
async function resolveStored(
	name: string,
	widths: ReadonlySet<number>,
	columns: number,
	budget: InlineBudget,
): Promise<ImageSource> {
	const stored = await storedImageSize(name);
	const synced = dotWidth(columns);

	const inline = new Map<number, ImageRaster>();
	for (const width of widths) {
		if (width !== synced) {
			const raster = await rasterFor(name, width);
			charge(name, raster, budget);
			inline.set(width, raster);
		}
	}

	return { width: stored.width, height: stored.height, inline };
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
