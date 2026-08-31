import { readAvatar } from "@/lib/auth/avatar-service";
import { currentUser, sessionVerdict } from "@/lib/auth/require-session";

/**
 * Serving one account's avatar.
 *
 * **Authenticated, but not permission-gated.** Any signed-in user may fetch any user's avatar,
 * because the panel already shows every operator's name and address on `/users` to anyone who can
 * open it, and the sidebar shows your own. Gating this on `users:read` would leave the users page
 * drawing broken images for exactly the operators allowed to see the page. What it does refuse is an
 * unauthenticated request: avatars are faces of the people who run the install, and a public
 * enumerable endpoint returning them is not something an install should have to opt out of.
 *
 * **"Authenticated" means every gate the panel applies, not merely a cookie that resolves.** Gated
 * with {@link currentUser} plus {@link sessionVerdict}, the pair `/api/events` uses and for the same
 * reason: `requireSession` signals by redirecting, and a redirect delivered to an `<img>` is an HTML
 * page arriving where image bytes were expected, so this route has to refuse with a status code
 * instead. What it must *not* do is what `currentUser` alone does — resolve the cookie and stop
 * there. That leaves the IP allowlist, the inactivity timeout, the forced password change and the
 * two-factor enrolment gate all unrun, so a session from an address since removed from
 * `auth.ipAllowlist`, or one sitting well past its timeout, could still walk `/api/avatar/<id>` for
 * every operator on the install. `sessionVerdict` is exactly those gates without the redirecting —
 * see its own doc for why a caller that repeats one of them by hand silently misses the rest.
 *
 * **`countsAsActivity: false`, for the reason `/api/events` sets it.** The browser fires this once
 * per avatar per page render, not once per thing an operator does, so a stream of them is evidence
 * of a page drawing rather than of anybody at the keyboard. Left counting as activity they would
 * refresh `lastSeenAt` on their own, and an unattended terminal with the Users tab open would never
 * reach its inactivity timeout. The gate still *reads* the stamp: a session already past the timeout
 * is refused here exactly as it is anywhere else.
 *
 * **Revalidated on every render, and answered with a 304 when nothing changed.** `no-cache,
 * must-revalidate` is what makes a re-crop appear immediately instead of after some cache's arbitrary
 * max-age, and the price of that is a request per avatar per page load. The conditional half is what
 * keeps that cheap: the App Router adds no `If-None-Match` handling to a hand-built `Response`, so
 * this route compares the header itself — see {@link matchesEtag} — and returns an empty 304 rather
 * than half a megabyte the browser already holds.
 *
 * **Outside `API_ROUTES` deliberately.** That registry is the v1 surface — API-key authentication
 * and one log line per request. This is a panel asset behind a session cookie, hit once per page
 * render per avatar; putting it there would flood the Logs tab with rows nobody asked for.
 */
export async function GET(request: Request, { params }: { params: Promise<{ userId: string }> }): Promise<Response> {
	const viewer = await currentUser();
	// One status for every refusal, unauthenticated and disallowed alike: which gate stopped a caller
	// is not something an `<img>` can act on, and saying so would tell an enumerating client which
	// accounts exist.
	if (viewer === null || (await sessionVerdict(viewer, { countsAsActivity: false })) !== "allowed") {
		return new Response(null, { status: 401 });
	}

	const { userId } = await params;
	const avatar = await readAvatar(userId);
	if (avatar === null) {
		// A 404 rather than a placeholder image: the caller is an `<img>` whose `onError` draws the
		// initial, and a served placeholder would have to guess at a name this route does not know.
		return new Response(null, { status: 404 });
	}

	const etag = `"${avatar.updatedAt.getTime()}"`;
	// `private` because the bytes are one account's; `no-cache` with the ETag so a re-crop is seen
	// immediately rather than after an arbitrary max-age. Sent on the 304 as well as the 200: a
	// revalidation that answered without them would leave the browser's stored copy with no freshness
	// information for the *next* render.
	const headers = { "Cache-Control": "private, no-cache, must-revalidate", ETag: etag };

	if (matchesEtag(request.headers.get("if-none-match"), etag)) {
		return new Response(null, { status: 304, headers });
	}

	// `avatar.bytes` handed over as it is: a `Buffer` is a `Uint8Array` subclass and a `BodyInit`
	// already, so the `new Uint8Array(...)` this used to wrap it in was an element-by-element copy of
	// the whole render on every uncached page load. `StoredAvatar.bytes` names the narrower
	// `Buffer<ArrayBuffer>` so the compiler agrees — see its own doc.
	return new Response(avatar.bytes, {
		status: 200,
		headers: { ...headers, "Content-Type": avatar.mimeType },
	});
}

/**
 * Whether an `If-None-Match` header names the tag this route just computed.
 *
 * The header was previously never read at all, which made the ETag decorative: paired with
 * `no-cache, must-revalidate` it had the browser revalidate on every render and then receive the
 * whole picture again every time, so `/users` on a fifty-operator install re-downloaded fifty
 * renders per page load to be told nothing had changed.
 *
 * A list rather than a single value, because the header is defined as one and a browser holding
 * several cached representations sends all of them. `W/` is stripped: this route only ever issues
 * strong tags, but an intermediary may weaken one, and a weak comparison is the correct one for
 * `If-None-Match` — a byte-for-byte identical render is what the tag promises either way.
 *
 * @param header the request's `If-None-Match`, or null when it carried none
 * @param etag the tag this response would be given
 * @returns whether the caller already holds this exact render
 */
function matchesEtag(header: string | null, etag: string): boolean {
	if (header === null) {
		return false;
	}
	return (
		header
			.split(",")
			.map((candidate) => candidate.trim().replace(/^W\//, ""))
			// `*` means "any representation you have", which for a route with exactly one is this one.
			.some((candidate) => candidate === etag || candidate === "*")
	);
}
