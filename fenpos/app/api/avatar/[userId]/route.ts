import { readAvatar } from "@/lib/auth/avatar-service";
import { currentUser } from "@/lib/auth/require-session";

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
 * **Outside `API_ROUTES` deliberately.** That registry is the v1 surface — API-key authentication
 * and one log line per request. This is a panel asset behind a session cookie, hit once per page
 * render per avatar; putting it there would flood the Logs tab with rows nobody asked for.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ userId: string }> }): Promise<Response> {
	const viewer = await currentUser();
	if (viewer === null) {
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
