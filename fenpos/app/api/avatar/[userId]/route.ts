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
 * **Outside `API_ROUTES` deliberately.** That registry is the v1 surface — API-key authentication
 * and one log line per request. This is a panel asset behind a session cookie, hit once per page
 * render per avatar; putting it there would flood the Logs tab with rows nobody asked for.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ userId: string }> }): Promise<Response> {
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

	return new Response(new Uint8Array(avatar.bytes), {
		status: 200,
		headers: {
			"Content-Type": avatar.mimeType,
			// `private` because the bytes are one account's; `no-cache` with the ETag so a re-crop is
			// seen immediately rather than after an arbitrary max-age.
			"Cache-Control": "private, no-cache, must-revalidate",
			ETag: `"${avatar.updatedAt.getTime()}"`,
		},
	});
}
