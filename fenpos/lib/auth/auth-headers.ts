import "server-only";
import { cookies, headers } from "next/headers";

/**
 * The headers to hand Better Auth, carrying the cookie jar as it stands *now*.
 *
 * Every `auth.api.*` call resolves its caller from a `Cookie` header, and the obvious thing to give
 * it is `headers()`. That is wrong for any request that has already replaced the session cookie,
 * and this panel has such requests: Better Auth's two-factor plugin deletes the session a request
 * arrived on and issues a new one — on a verified `verifyTOTP`, and on `disableTwoFactor` — writing
 * the replacement through `nextCookies()` into Next's cookie store. `headers()` goes on returning
 * the `Cookie` header the browser sent, so anything later in that same request looks up a session
 * row that no longer exists and concludes nobody is signed in.
 *
 * "Later in that same request" is not hypothetical: writing a cookie during a server action sets
 * `pathWasRevalidated` in Next's own cookie adapter, which makes Next re-render the current page
 * before replying. That render runs the panel layout, and therefore the session gate.
 *
 * `cookies()` is the store Next keeps current. Its action handler switches the request to the
 * render phase and calls `synchronizeMutableCookies` first, precisely so the render sees cookies
 * the action wrote; the same function carries a note that headers are *not* given that treatment.
 * So the cookie store is the only in-request view of the jar that is up to date, and this function
 * is where the two are put back together.
 *
 * On a request that has written no cookie the two agree, and this returns what the caller would
 * have passed anyway.
 *
 * @returns the request's headers, with `Cookie` taken from Next's cookie store
 */
export async function authHeaders(): Promise<Headers> {
	const requestHeaders = new Headers(await headers());

	// Built from `getAll()` rather than from the store's own `toString()`, and that is not a
	// stylistic choice. `cookies()` returns a different underlying type depending on the request's
	// phase: during a server action it is Next's `userspaceMutableCookies`, which proxies a
	// `ResponseCookies`, and *that* `toString()` runs every entry through `stringifyCookie` — it
	// emits `name=value; Path=/; HttpOnly; SameSite=Lax; Max-Age=…`, which is `Set-Cookie` syntax
	// and not what a `Cookie` request header may carry. It happens to come out clean while every
	// entry was seeded from the incoming request, because those carry no attributes — so the one
	// moment it would go wrong is a reader placed after a rotation, which is the whole reason this
	// function exists. `getAll()` is on both types and returns plain `{ name, value }`, so the pairs
	// below are exact in either phase.
	//
	// Values are percent-encoded here because Better Auth's own cookie parser runs every value
	// through `tryDecode`, so the round trip is lossless.
	const jar = (await cookies())
		.getAll()
		.map((cookie) => `${cookie.name}=${encodeURIComponent(cookie.value)}`)
		.join("; ");

	if (jar === "") {
		requestHeaders.delete("cookie");
	} else {
		requestHeaders.set("cookie", jar);
	}
	return requestHeaders;
}
