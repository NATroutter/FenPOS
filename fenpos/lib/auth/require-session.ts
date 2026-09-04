import "server-only";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth/auth";
import { authHeaders } from "@/lib/auth/auth-headers";
import { addressAllowed } from "@/lib/auth/ip-allowlist";
import { accountPasswordExpired } from "@/lib/auth/password-history";
import { keepSessionAlive } from "@/lib/auth/session-policy";
import { isInstallClaimed } from "@/lib/auth/setup-key";
import { prisma } from "@/lib/db";
import { getClientAddress } from "@/lib/request-context";
import { booleanSetting, globalSignInPolicy } from "@/lib/settings/settings-service";

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
	 * lets an audit row say which session did something, which is what
	 * `RequestProvenance.sessionId` is for.
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
 * Resolved through {@link authHeaders} rather than through `headers()` directly. A request that has
 * already replaced its own session cookie — which is what confirming or removing a second factor
 * does — still carries the *old* one in `headers()`, and reading that would make this report
 * nobody as signed in while the caller is holding a session that was issued moments earlier.
 *
 * @returns the signed-in user, or null
 */
export async function currentUser(): Promise<PanelUser | null> {
	const session = await auth.api.getSession({ headers: await authHeaders() });
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
 * The session id the request is holding **right now**, read fresh rather than trusted from a
 * {@link PanelUser} resolved earlier in the same request.
 *
 * Exists for the audit trail. Three panel actions rotate the caller's session as part of doing their
 * own work — `changePassword`'s `revokeOtherSessions: true`, and `verifyTOTP`/`disableTwoFactor`
 * behind `self:confirm-2fa` and `self:end-2fa` — so a `PanelUser` resolved before any of those ran
 * still carries the session id the rotation is about to delete. `panel-action.ts`'s `record()` calls
 * this after the action's body has run, so the row it writes names whichever session the request
 * ends up on. Read through {@link authHeaders} for the same reason {@link currentUser} is: a
 * rotation is a cookie write, and `headers()` alone still shows the cookie the request arrived with.
 *
 * **Never throws.** Falls back to `fallback` on any failure to read the live session — most notably
 * having no request scope at all, the same condition `requestProvenance` exists to absorb — and also
 * when the live read finds nobody signed in, which none of the three actions above should ever
 * produce: each of them keeps the caller signed in, just under a different session.
 *
 * @param fallback the session id to report if the live read fails or names no session
 * @returns the session id the request is holding now
 */
export async function currentSessionId(fallback: string): Promise<string> {
	try {
		const session = await auth.api.getSession({ headers: await authHeaders() });
		return session?.session.id ?? fallback;
	} catch {
		return fallback;
	}
}

/**
 * What the gates below decided about a session that is genuinely signed in.
 *
 * A verdict rather than a redirect, because not every caller can redirect. `/api/events` holds a
 * connection a browser's `EventSource` opened expecting `text/event-stream`, and a redirect there is
 * followed and delivered as HTML on that connection — so it has to refuse with a status code
 * instead. Before this existed it repeated the one gate it knew about by hand and silently missed
 * the three that were added around it, including the two-factor enrolment gate that `auth.require2fa`
 * is bought for. Naming the verdicts is what makes "every gate, everywhere" structural: a gate added
 * to {@link sessionVerdict} reaches both callers, and a new verdict is a compile error in the
 * `switch` below until somebody says what to do about it.
 */
export type SessionVerdict =
	| "allowed"
	| "password-change-owed"
	| "address-not-allowed"
	| "idle-too-long"
	| "password-expired"
	| "enrolment-owed";

/**
 * Runs every gate a signed-in session must still pass, and says which one stopped it.
 *
 * Takes the user rather than resolving one, so a caller that has already paid for `currentUser` does
 * not pay twice — and so this stays about the gates rather than about authentication.
 *
 * **Not free of side effects, deliberately.** It sets the forced-reset flag on an account whose
 * password has just expired — unconditionally, because that is a fact about the password rather than
 * about the caller — and by default it marks the session as seen, including on the `mustChangePassword`
 * branch below, before it returns.
 *
 * **`mustChangePassword` still marks the session as seen, even though it returns before the idle
 * check that reads the same stamp — and it writes the stamp directly rather than through
 * `keepSessionAlive`.** That helper refuses to write once a session already reads as idle past the
 * configured timeout (see its own early return), which is the right call for every other reader: an
 * idle session should not get to refresh its own reprieve. It is the wrong call here. This branch is
 * unconditionally reachable while the flag is set, whether or not a timeout is already past due, and
 * a forced password change outranks the idle check the same way it outranks every gate below — an
 * operator who takes longer than the configured timeout to pick a new password must still land on
 * `/set-password`, not `/login`, and *that* request is exactly the one `keepSessionAlive` would have
 * refused to stamp. Without the direct write, `lastSeenAt` would sit frozen at whatever it was when
 * the reset began for as long as the operator takes, and the moment the flag clears, the very next
 * request would reach the idle check for the first time and judge the session against that stale
 * stamp — timing it out immediately despite the operator having been on the page throughout.
 *
 * **The second write is the caller's to decline, with `countsAsActivity: false`.** Marking a session
 * as seen is a claim that somebody used it, and both readers of `lastSeenAt` believe that claim: the
 * inactivity timeout and the concurrency cap. It holds for a panel page and for a server action, and
 * that is why it is the default. It does not hold for `/api/events`, which the browser's `EventSource`
 * reopens by itself after every dropped connection — a stream reconnecting on a lossy network would
 * otherwise keep an unattended terminal signed in forever and make an abandoned tab look like the
 * account's most recently used session. Declining the write changes no verdict: an idle session is
 * still `"idle-too-long"`, measured against the stamp the last real request left.
 *
 * It does *not* destroy sessions. Ending one writes a cookie, and what that should mean differs by
 * caller: a page redirects to `/login` and must not leave a live session behind to bounce back, while
 * a streaming route simply refuses and lets the next navigation deal with it.
 *
 * @param user the signed-in user, from {@link currentUser}
 * @param options `skipEnrolmentGate` skips the last gate only — see {@link requireSession};
 *   `countsAsActivity` defaults to true and is set false only by a caller whose requests the user did
 *   not make — see {@link keepSessionAlive}
 * @returns `"allowed"`, or the gate that turned the session away
 */
export async function sessionVerdict(
	user: PanelUser,
	options: { skipEnrolmentGate?: boolean; countsAsActivity?: boolean } = {},
): Promise<SessionVerdict> {
	if (user.mustChangePassword) {
		// Unconditional, unlike `keepSessionAlive`'s own write — see this function's own doc for why
		// a session already past the idle timeout must still be stamped here. Swallowed rather than
		// awaited into a throw: the session may have been revoked between `currentUser` resolving it
		// and this write running (an administrator's concurrent action, another tab signing out), and
		// nothing below depends on this write succeeding — the redirect happens regardless.
		if (options.countsAsActivity ?? true) {
			await prisma.session
				.update({ where: { id: user.sessionId }, data: { lastSeenAt: new Date() } })
				.catch(() => undefined);
		}
		return "password-change-owed";
	}

	// Re-checked on every request, not only at sign-in. Checking only at sign-in would leave an
	// operator who signed in from home before the allowlist was tightened working until their session
	// lapsed, which is the opposite of what tightening one is for.
	const { ipAllowlist } = await globalSignInPolicy();
	if (!addressAllowed(await getClientAddress(), ipAllowlist)) {
		return "address-not-allowed";
	}

	// After the allowlist, before the password check: both of the first two end the session outright,
	// and there is no sense asking whether a password has expired on a session that is not going to
	// continue. This is also the call that marks the session as seen, so it must run on every request
	// that reaches here — including the ones that go on to redirect because the password has just
	// expired, two branches below. (The `mustChangePassword` branch above short-circuits before this
	// and always has: a session held by an account that already owes a change is not being used.)
	// Passed straight through rather than defaulted here: the default lives with the function that
	// acts on it, so there is one place saying that an unspecified caller counts as activity.
	if (!(await keepSessionAlive(user.sessionId, { countsAsActivity: options.countsAsActivity }))) {
		return "idle-too-long";
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
		return "password-expired";
	}

	// Last of the gates, and deliberately: a forced password change outranks it, because
	// `/set-password` is reachable without a second factor and enrolling one while owing a password
	// change would leave the account holding a factor for a password it is about to replace.
	//
	// The flag is consulted before the setting is read, so `&&` short-circuits: an account that
	// already has one is not asked again, and an install that does not require two factors — the
	// default — pays one settings read and no more.
	//
	// Skippable, and only by this one condition — see `skipEnrolmentGate` on `requireSession`.
	// Everything before this point still ran: an account on a disallowed address or past its
	// inactivity timeout is still turned away before it ever reaches the actions this flag exists for.
	if (!options.skipEnrolmentGate && !user.twoFactorEnabled && (await booleanSetting("auth.require2fa"))) {
		return "enrolment-owed";
	}

	return "allowed";
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
 * The gates themselves live in {@link sessionVerdict}; what is here is only what to *do* about each
 * answer, which is the half that cannot be shared with a caller that must not redirect.
 *
 * @param options `skipEnrolmentGate` exists for exactly one caller: `panel-action.ts`'s `gate`,
 *   for the two actions that are how enrolment happens (`self:begin-2fa`, `self:confirm-2fa`). Those
 *   run from `/enrol-2fa` itself — an account with none, on an install that requires one — so the
 *   ordinary call here would redirect to the very page already asking for the click, and
 *   `startTwoFactor` would hand back a redirect instead of a QR. Every other gate still applies with
 *   the flag set; only the last one, the one these actions exist to satisfy, is skipped.
 * @returns the signed-in user; never null
 */
export async function requireSession(options: { skipEnrolmentGate?: boolean } = {}): Promise<PanelUser> {
	const user = await currentUser();

	if (!user) {
		redirect((await isInstallClaimed()) ? "/login" : "/setup");
	}

	// `return redirect(...)` rather than a bare call: `redirect` is typed `never` and signals by
	// throwing, so the `return` changes nothing at runtime — it is there so the lint rule that
	// forbids a `case` falling into the next one can see that none of these do.
	switch (await sessionVerdict(user, options)) {
		case "allowed":
			return user;
		case "password-change-owed":
		case "password-expired":
			return redirect("/set-password");
		// The session is destroyed, not merely redirected. `/login` bounces an authenticated visitor to
		// `/dashboard`, so sending a still-valid session there would loop between the two forever — and
		// a session from an address that may no longer reach this install, or one that has sat past its
		// inactivity timeout, is the honest thing to end.
		case "address-not-allowed":
		case "idle-too-long":
			await auth.api.signOut({ headers: await authHeaders() });
			return redirect("/login");
		case "enrolment-owed":
			return redirect("/enrol-2fa");
	}
}
