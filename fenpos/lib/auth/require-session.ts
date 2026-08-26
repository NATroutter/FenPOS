import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth/auth";
import { addressAllowed } from "@/lib/auth/ip-allowlist";
import { accountPasswordExpired } from "@/lib/auth/password-history";
import { keepSessionAlive } from "@/lib/auth/session-policy";
import { isInstallClaimed } from "@/lib/auth/setup-key";
import { prisma } from "@/lib/db";
import { getClientAddress } from "@/lib/request-context";
import { globalSignInPolicy } from "@/lib/settings/settings-service";

/**
 * The panel's session gate.
 *
 * Every panel page and every server action calls this. The layout already guards the page, but an
 * action is a POST endpoint in its own right: anything that trusted the layout would be callable
 * directly by anyone who knew the action id. Authorisation belongs at the action, not at the page
 * that happens to render its button.
 *
 * **It redirects rather than returning an error.** Each tab used to keep its own copy of this
 * check, throwing an error that the action's own catch turned into a toast — so a session that
 * expired while the panel sat open produced "Not signed in." over a screen still showing agents,
 * printers and keys, and an operator who dismissed it was left looking at a panel where nothing
 * worked and nothing said why. There is one thing to do when the session is gone, and the panel
 * should just do it.
 *
 * `redirect` signals by throwing, so this must be called **outside** any `try` that catches
 * broadly — a catch that swallowed it would reinstate the behaviour this exists to remove.
 */

/** The signed-in user, as every panel page and action needs them. */
export interface PanelUser {
	id: string;
	name: string;
	email: string;
	/** Bypasses every permission check. */
	isSuperuser: boolean;
	/** True while the account owes a password change and can reach nothing but the page that takes it. */
	mustChangePassword: boolean;
	/**
	 * The session this request arrived on.
	 *
	 * Carried on the user rather than fetched again, because every caller that wants it already has
	 * this object and a second `getSession` would be a second read of the same cookie. It is what
	 * lets an audit row say which session did something — `RequestProvenance.sessionId` has had a
	 * field for it since phase 2 and, until now, no caller able to supply one.
	 */
	sessionId: string;
	/** Whether the account has a confirmed authenticator. Read by the enrolment gate. */
	twoFactorEnabled: boolean;
}

/**
 * Resolves the current request's user without redirecting.
 *
 * For the few callers that must distinguish "nobody is signed in" from "somebody is" and act on
 * the difference — the sign-in page deciding whether to bounce an already-authenticated visitor,
 * and the setup route deciding what to render. Everything else wants {@link requireSession}.
 *
 * @returns the signed-in user, or null
 */
export async function currentUser(): Promise<PanelUser | null> {
	const session = await auth.api.getSession({ headers: await headers() });
	if (!session?.user) {
		return null;
	}

	const user = session.user;
	return {
		id: user.id,
		name: user.name,
		email: user.email,
		// Read through Boolean rather than trusted as typed: these arrive from a database column
		// that SQLite stores as an integer, and a null from a row written before the column
		// existed must read as "no", never as "unknown" and certainly never as "yes".
		isSuperuser: Boolean(user.isSuperuser),
		mustChangePassword: Boolean(user.mustChangePassword),
		sessionId: session.session.id,
		twoFactorEnabled: Boolean(user.twoFactorEnabled),
	};
}

/**
 * Sends the caller away unless the request carries a usable session.
 *
 * "Usable" is stricter than "authenticated": a user who owes a password change holds a valid
 * session and still reaches nothing but the page that takes the new password. That gate lives
 * here, rather than at sign-in, because this is what every panel page and action is behind — so a
 * URL typed straight into the address bar is caught too, and so a forced reset cannot be walked
 * around by knowing an action id.
 *
 * An unauthenticated caller on an install with no accounts goes to `/setup` rather than `/login`,
 * because there is nothing to sign in to yet and a sign-in form that can never succeed is a dead
 * end. That is a routing convenience only — the seal in `setup.ts` is what actually decides
 * whether setup may proceed.
 *
 * @returns the signed-in user; never null
 */
export async function requireSession(): Promise<PanelUser> {
	const user = await currentUser();

	if (!user) {
		redirect((await isInstallClaimed()) ? "/login" : "/setup");
	}

	if (user.mustChangePassword) {
		redirect("/set-password");
	}

	// Re-checked on every request, not only at sign-in. Checking only at sign-in would leave an
	// operator who signed in from home before the allowlist was tightened working until their session
	// lapsed, which is the opposite of what tightening one is for.
	const { ipAllowlist } = await globalSignInPolicy();
	if (!addressAllowed(await getClientAddress(), ipAllowlist)) {
		// The session is destroyed, not merely redirected. `/login` bounces an authenticated visitor to
		// `/dashboard`, so sending a still-valid session there would loop between the two forever — and
		// a session from an address that may no longer reach this install is the honest thing to end.
		await auth.api.signOut({ headers: await headers() });
		redirect("/login");
	}

	// After the allowlist, before the password check: both of the first two end the session outright,
	// and there is no sense asking whether a password has expired on a session that is not going to
	// continue. This is also the call that marks the session as seen, so it must run on every
	// request that reaches here — including the ones that go on to redirect for a password change.
	if (!(await keepSessionAlive(user.sessionId))) {
		// Destroyed rather than redirected, for the reason the allowlist branch above gives: `/login`
		// bounces an authenticated visitor to `/dashboard`, and a session left alive would loop
		// between the two.
		await auth.api.signOut({ headers: await headers() });
		redirect("/login");
	}

	// An expired password **sets the forced-reset flag** rather than merely redirecting, and that is
	// load-bearing: `/set-password` bounces anyone whose `mustChangePassword` is false to `/dashboard`,
	// so a bare redirect here would put the two pages in an infinite loop. Setting the flag makes
	// expiry converge with the mechanism that already exists — the page renders, the action clears the
	// flag once the new password is stored, and the audit trail says what it always said.
	//
	// Written on a read path, once: the `mustChangePassword` branch above short-circuits every request
	// after this one, so this costs a single write at the moment the password expires.
	if (await accountPasswordExpired(user.id)) {
		await prisma.user.update({ where: { id: user.id }, data: { mustChangePassword: true } });
		redirect("/set-password");
	}

	return user;
}
