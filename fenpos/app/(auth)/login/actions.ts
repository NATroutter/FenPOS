"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { recordAudit, unknownUserActor, userActor } from "@/lib/audit/audit-log";
import { AUTH_AUDIT_ACTIONS } from "@/lib/audit/auth-events";
import { requestProvenance } from "@/lib/audit/provenance";
import { auth } from "@/lib/auth/auth";
import { addressAllowed } from "@/lib/auth/ip-allowlist";
import { clearFailedSignIns, lockedOutFor, recordFailedSignIn } from "@/lib/auth/lockout";
import { consumeSignInAttempt, signInLimiter } from "@/lib/auth/rate-limit";
import { enforceSessionCap } from "@/lib/auth/session-policy";
import { TURNSTILE_FIELD, turnstileConfig, verifyTurnstile } from "@/lib/auth/turnstile";
import { prisma } from "@/lib/db";
import { formatDateTime } from "@/lib/format/datetime";
import { logger } from "@/lib/logger";
import { getClientAddress } from "@/lib/request-context";
import { globalSignInPolicy } from "@/lib/settings/settings-service";

/**
 * Sign-in.
 *
 * Every check runs on the server. The form does no validation that matters, because a form is not
 * a security boundary — anything the browser enforces can be skipped by posting directly to this
 * action.
 */

/**
 * A ban, in the pieces the form lays out separately.
 *
 * The two facts arrive apart rather than pre-joined into one sentence because they are read
 * differently: the expiry is a timestamp somebody checks against a calendar, the reason is prose
 * somebody reads. Run together in one paragraph the timestamp wrapped across a line break mid-value
 * — "9/4/2026," on one line and "3:00:00 AM" on the next — and the reason ran on from it as though
 * it were part of the same clause.
 */
export interface BanNotice {
	/**
	 * When the ban lifts, already formatted, or null for one that does not lift on its own.
	 *
	 * Formatted on the server rather than sent as an ISO string for the form to render: the sign-in
	 * page is outside the panel's `FormatProvider`, so `formatDateTime` on that side would fall back
	 * to this module's built-in locale and disagree with every timestamp in the panel behind it.
	 */
	until: string | null;
	/** Why, in the operator's own words from the ban form. Null when none was recorded. */
	reason: string | null;
}

/** What the form renders after a submission. */
export interface SignInState {
	/** Message to display, or null before the first attempt. */
	error: string | null;
	/**
	 * Set alongside {@link error} when the refusal was a ban, so the form can lay the facts out on
	 * separate lines instead of rendering one run-on sentence.
	 *
	 * Optional rather than a nulled field on every other return: a ban is one branch out of eight,
	 * and `ban: null` repeated seven times says nothing the absence does not.
	 */
	ban?: BanNotice;
	/**
	 * True once the password has been accepted and a second factor is owed.
	 *
	 * The form swaps its fields on this rather than navigating. The plugin's own challenge cookie is
	 * what actually carries the state between the two submissions, so a refresh loses the *screen*
	 * and not the *challenge* — signing in again lands on the same step.
	 */
	twoFactorRequired: boolean;
}

/** Shown for every failure that is not a ban, whatever its cause. */
const REJECTION_MESSAGE = "That email address and password do not match an account.";

/**
 * Shown when the bot challenge did not stand.
 *
 * Its own message rather than {@link REJECTION_MESSAGE}, and that is not a leak: it says nothing
 * about whether the address holds an account, only that the widget on this page needs solving
 * again. Collapsing it into "credentials do not match" would send an operator to reset a password
 * that was never looked at — the same mistake the ban message was fixed to stop making.
 */
const CHALLENGE_MESSAGE = "That challenge could not be verified. Try again.";

/** The code better-auth's admin plugin puts on the refusal it throws for a banned account. */
const BANNED_CODE = "BANNED_USER";

/**
 * Whether a thrown sign-in failure is the admin plugin's ban refusal.
 *
 * Read off `body.code` rather than with `instanceof APIError`. The class is exported from both
 * `better-auth` and `@better-auth/core`, and an `instanceof` that happens to hold the other copy
 * fails silently — which here would mean quietly falling back to "credentials do not match" for a
 * ban, the exact bug this function exists to fix.
 *
 * @param error whatever `signInEmail` threw
 * @returns whether it refused because the account is banned
 */
function isBanRefusal(error: unknown): boolean {
	if (typeof error !== "object" || error === null || !("body" in error)) {
		return false;
	}
	const body = (error as { body: unknown }).body;
	return typeof body === "object" && body !== null && "code" in body && body.code === BANNED_CODE;
}

/**
 * What a banned operator is told.
 *
 * The reason and the expiry both, because "you are banned" on its own leaves somebody with nothing
 * to act on: whether to wait, or who to go and talk to. The reason is the operator's own words from
 * the ban form, and the ban screen in the panel shows the same two facts.
 *
 * Returns the pieces *and* a flat sentence. The form renders the pieces; `error` carries the
 * sentence because it is what every other refusal on this screen sets, and a state where the only
 * message lives in a field older code does not read is a state that renders as nothing at all.
 *
 * @param ban the stored ban, as read after the password was accepted
 * @returns the state to render
 */
function bannedState(ban: { banReason: string | null; banExpires: Date | null }): SignInState {
	const notice: BanNotice = {
		until: ban.banExpires ? formatDateTime(ban.banExpires) : null,
		reason: ban.banReason,
	};
	const until = notice.until ? ` until ${notice.until}` : "";
	const reason = notice.reason ? ` Reason: ${notice.reason}` : "";
	return {
		error: `This account is banned${until}.${reason}`,
		ban: notice,
		twoFactorRequired: false,
	};
}

/**
 * Reads the submitted address for the audit row.
 *
 * Normalised the same way the credential check normalises it, so a row and a sign-in agree about
 * what was tried. Returns the empty string rather than null for a submission that carried no
 * address at all, because "somebody posted this form with no email" is itself worth recording.
 *
 * @param formData the submitted form
 * @returns the normalised address, or the empty string when none was submitted
 */
function readEmail(formData: FormData): string {
	const email = formData.get("email");
	return typeof email === "string" ? email.trim().toLowerCase() : "";
}

/**
 * Verifies credentials and starts a session.
 *
 * Failures are deliberately indistinguishable: a wrong password, an address with no account, a
 * locked account, and a malformed submission all produce the same message. Telling them apart
 * would disclose which addresses hold accounts on this install, which is useful only to someone
 * who should not be here. The server log records the difference.
 *
 * **A ban is the one exception, and it is one because the password was right.** Telling somebody
 * with the wrong password that an account is banned would be the enumeration oracle the paragraph
 * above exists to prevent; telling somebody who has just proved they hold the credential discloses
 * nothing they could not already establish. What made this safe to do is *where* the admin plugin
 * checks: `banned` is read in a `session.create.before` database hook, which runs only once a
 * session is about to be issued — that is, after the password has been verified. A future version
 * that moved the check earlier would turn this branch into a leak, which is why the reasoning is
 * written down here rather than left to be re-derived.
 *
 * The ban message names the reason and the expiry, because "you are banned" alone leaves an
 * operator with nothing to act on. Before this, a banned account was told its own password was
 * wrong, which sent people to reset a credential that was never the problem.
 *
 * A banned account is refused by Better Auth itself, so the ban is enforced at the credential
 * layer rather than by a check the panel could forget to make.
 *
 * Every outcome is written to the audit record as well as to the log — the two are separate
 * channels with separate audiences, and the record is the one that survives log rotation.
 *
 * @param _previous the prior form state, required by useActionState and unused
 * @param formData the submitted form
 * @returns the state to render, or never when sign-in succeeds and redirects
 */
export async function signIn(_previous: SignInState, formData: FormData): Promise<SignInState> {
	const address = await getClientAddress();
	const policy = await globalSignInPolicy();

	// First, and ahead of the throttle: an address that may not reach this install at all should not
	// consume a throttle budget that legitimate operators elsewhere share.
	if (!addressAllowed(address, policy.ipAllowlist)) {
		logger.warn("Sign-in refused by the address allowlist", { address });
		await recordAudit({
			action: AUTH_AUDIT_ACTIONS.SIGN_IN,
			outcome: "DENIED",
			actor: unknownUserActor(readEmail(formData)),
			detail: { reason: "address-not-allowed" },
			provenance: await requestProvenance(),
		});
		// The same message a wrong password gets. An allowlist that announced itself would tell an
		// attacker they had found a real install and needed only a different address to come from.
		return { error: REJECTION_MESSAGE, twoFactorRequired: false };
	}

	// Consumed before the credentials are examined, so attempts are counted whether or not the
	// submission is well-formed.
	const limit = await consumeSignInAttempt(address);
	if (!limit.allowed) {
		const seconds = Math.ceil(limit.retryAfterMs / 1000);
		logger.warn("Sign-in rate limit engaged", { address, retryAfterSeconds: seconds });
		await recordAudit({
			action: AUTH_AUDIT_ACTIONS.SIGN_IN,
			outcome: "DENIED",
			actor: unknownUserActor(readEmail(formData)),
			detail: { reason: "rate-limited", retryAfterSeconds: seconds },
			provenance: await requestProvenance(),
		});
		return { error: `Too many attempts. Try again in ${seconds} seconds.`, twoFactorRequired: false };
	}

	const email = formData.get("email");
	const password = formData.get("password");

	if (typeof email !== "string" || email.trim() === "" || typeof password !== "string" || password.length === 0) {
		await recordAudit({
			action: AUTH_AUDIT_ACTIONS.SIGN_IN,
			outcome: "DENIED",
			actor: unknownUserActor(readEmail(formData)),
			detail: { reason: "malformed" },
			provenance: await requestProvenance(),
		});
		return { error: REJECTION_MESSAGE, twoFactorRequired: false };
	}

	// Before the password is examined and after the two cheap refusals above it: the challenge is a
	// network round trip, and spending one on a junk POST or on an address that is already over its
	// throttle would let the thing meant to make this form expensive to hammer be the expensive part.
	//
	// After the malformed check for the same reason, and before the lockout read because a bot
	// working through addresses should not get to find out which ones are locked.
	const challenge = await turnstileConfig();
	if (challenge.enabled) {
		const submitted = formData.get(TURNSTILE_FIELD);
		const verdict = await verifyTurnstile(typeof submitted === "string" ? submitted : "", address);
		if (!verdict.ok) {
			logger.warn("Sign-in refused by the bot challenge", {
				address,
				reason: verdict.reason,
				// Cloudflare's own codes, which name causes an operator can act on — a wrong secret key,
				// or a token already spent. Never shown to whoever is signing in.
				...(verdict.reason === "rejected" ? { codes: verdict.codes } : {}),
			});
			await recordAudit({
				action: AUTH_AUDIT_ACTIONS.SIGN_IN,
				outcome: "DENIED",
				actor: unknownUserActor(readEmail(formData)),
				detail: { reason: "challenge-failed", challenge: verdict.reason },
				provenance: await requestProvenance(),
			});
			return { error: CHALLENGE_MESSAGE, twoFactorRequired: false };
		}
	}

	// After the throttle, because this is a database read and that one is in memory; and after the
	// malformed check, because there is no address to look up before it.
	const lockedFor = await lockedOutFor(email);
	if (lockedFor > 0) {
		logger.warn("Sign-in refused: account locked", { address, email: email.trim().toLowerCase() });
		await recordAudit({
			action: AUTH_AUDIT_ACTIONS.SIGN_IN,
			outcome: "DENIED",
			actor: unknownUserActor(readEmail(formData)),
			detail: { reason: "locked", retryAfterSeconds: Math.ceil(lockedFor / 1000) },
			provenance: await requestProvenance(),
		});
		// Deliberately not "this account is locked". That would confirm the address holds an account,
		// and hand an attacker a way to enumerate them by locking each one in turn.
		return { error: REJECTION_MESSAGE, twoFactorRequired: false };
	}

	let signedIn: Awaited<ReturnType<typeof auth.api.signInEmail>>;
	try {
		signedIn = await auth.api.signInEmail({
			body: { email: email.trim().toLowerCase(), password },
			headers: await headers(),
		});
	} catch (error) {
		const normalised = email.trim().toLowerCase();

		// A ban leaves before the counting below. The password was right, so counting it as a failed
		// attempt would lock an account for a credential nobody got wrong — and would then hold the
		// lock past the ban being lifted.
		if (isBanRefusal(error)) {
			const account = await prisma.user.findFirst({
				where: { email: normalised },
				select: { id: true, name: true, email: true, banReason: true, banExpires: true },
			});
			logger.warn("Sign-in refused: account banned", { address, email: normalised });
			await recordAudit({
				action: AUTH_AUDIT_ACTIONS.SIGN_IN,
				outcome: "DENIED",
				// Named, not anonymous, for the reason the two-factor deferral below is: the password was
				// accepted, so the account is not in doubt and the enumeration argument that
				// `unknownUserActor` exists for — which is about refusals to *unidentified* callers — does
				// not apply.
				actor: account ? userActor(account) : unknownUserActor(readEmail(formData)),
				detail: { reason: "banned" },
				provenance: await requestProvenance(),
			});
			// The row can be missing only if the account was deleted between the hook reading it and
			// this query; the generic ban wording still beats claiming the password was wrong.
			return bannedState(account ?? { banReason: null, banExpires: null });
		}

		// Counted against the account rather than the address. A wrong password and an unknown address
		// both land here, and `recordFailedSignIn` is silent about the second of those.
		await recordFailedSignIn(email);
		logger.warn("Failed sign-in attempt", {
			address,
			email: normalised,
			remainingAttempts: limit.remaining,
			reason: error instanceof Error ? error.message : String(error),
		});
		await recordAudit({
			action: AUTH_AUDIT_ACTIONS.SIGN_IN,
			outcome: "DENIED",
			actor: unknownUserActor(readEmail(formData)),
			detail: { reason: "rejected", remainingAttempts: limit.remaining },
			provenance: await requestProvenance(),
		});
		return { error: REJECTION_MESSAGE, twoFactorRequired: false };
	}

	// The password was right either way, so the throttle and the failure count are cleared before the
	// branch: an operator who then fumbles a TOTP code has not mistyped their password, and counting
	// it against them would lock accounts for having a slow phone.
	signInLimiter.reset(address);

	// Better Auth defers instead of returning a session when the account carries a second factor. It
	// has already set its own challenge cookie by this point; nothing here has to carry state.
	if ("twoFactorRedirect" in signedIn && signedIn.twoFactorRedirect) {
		// `signedIn` carries no user id on this arm — the plugin's response here is exactly
		// `{ twoFactorRedirect: true, twoFactorMethods }` — so the account is looked up by the
		// address already validated above. Scoped to this branch: the full-success arm below already
		// has `signedIn.user.id` and would only be paying for a lookup it does not need.
		const passwordAccount = await prisma.user.findFirst({
			where: { email: email.trim().toLowerCase() },
			select: { id: true, name: true, email: true },
		});
		if (passwordAccount) {
			await clearFailedSignIns(passwordAccount.id);
		}
		await recordAudit({
			action: AUTH_AUDIT_ACTIONS.SIGN_IN,
			outcome: "SUCCESS",
			// Named, not anonymous. The password was accepted, so the account is no longer in doubt and
			// the enumeration argument `unknownUserActor` exists for does not apply — that argument is
			// about *refusals*. It was resolved four lines above; leaving the row anonymous only meant
			// somebody reading the record had to correlate it with the two-factor row by time.
			actor: passwordAccount ? userActor(passwordAccount) : unknownUserActor(readEmail(formData)),
			detail: { stage: "password", twoFactorRequired: true },
			provenance: await requestProvenance(),
		});
		// Deliberately not "wrong password" and deliberately not silent: the operator needs to know
		// what to type next, and by this point they have already proved they hold the password.
		return { error: null, twoFactorRequired: true };
	}

	if (!("user" in signedIn)) {
		// Unreachable: the union has exactly two arms and the deferral is handled above. Checked so
		// that a plugin adding a third arm is a refusal rather than a crash on `signedIn.user`.
		return { error: REJECTION_MESSAGE, twoFactorRequired: false };
	}

	await clearFailedSignIns(signedIn.user.id);

	// After the session exists, so the new one is counted and protected. `signInEmail` returns the
	// session's token rather than its row, so the row is found by that unique column and its id is
	// pinned — without that, a cap of one could sort the just-created session behind an existing one
	// on a coarse clock and sign the caller straight back out.
	const newSession = await prisma.session.findUnique({ where: { token: signedIn.token }, select: { id: true } });
	await enforceSessionCap(signedIn.user.id, newSession?.id ?? null);

	logger.info("Signed in", { address, email: email.trim().toLowerCase() });

	// `sessionId` stays null on this row. `signInEmail` returns a token rather than a session id,
	// and re-reading the session in this request would not see a cookie that has not been sent yet.
	// The user id is on the row; correlate by user and time.
	await recordAudit({
		action: AUTH_AUDIT_ACTIONS.SIGN_IN,
		outcome: "SUCCESS",
		actor: userActor(signedIn.user),
		provenance: await requestProvenance(),
	});

	// Outside the try/catch that would otherwise swallow it: redirect() signals by throwing.
	redirect("/dashboard");
}

/**
 * Verifies the second factor and finishes the sign-in.
 *
 * Takes a TOTP code or a recovery code in the same field. Asking an operator which kind they are
 * about to type is a question they should not have to answer under pressure — the two are different
 * shapes and this picks the endpoint from the shape.
 *
 * **One submission costs one attempt, and picking by shape is what buys that.** Trying the
 * authenticator and falling back to the recovery code on failure sent every wrong code to both
 * endpoints, and each of them spends from the same two budgets — so five per-challenge attempts died
 * on the third submission and ten per-account failures on the fifth. That landed hardest on the case
 * this flow expects, a phone whose clock has drifted, and because the account lockout covers the
 * recovery codes too it locked the operator out of the very thing they would reach for next.
 *
 * A six-digit string is a TOTP code and nothing else: the plugin's own recovery codes are two groups
 * of five alphanumerics joined by a hyphen (`generateBackupCodesFn`, `two-factor/backup-codes`), so
 * the two sets do not overlap and neither endpoint is ever asked about a code meant for the other.
 * Both refusals return the same message, deliberately — one that said which kind of code was
 * expected would tell a password-holder whether the account still had recovery codes left.
 *
 * Deliberately **not** rate-limited by address the way the password step is: the throttle was
 * already cleared when the password was accepted, and an attacker who has reached this step holds a
 * valid password, so the thing worth counting is codes against this challenge rather than requests
 * from this address. That counting already exists and this action does not need to add it: the
 * plugin caps attempts *per challenge* at five (`beginAttempt(5)` in
 * `two-factor/{totp,backup-codes}/index.mjs`), destroying the challenge cookie once they are spent,
 * and separately caps them *per account, across challenges* at ten consecutive failures
 * (`accountLockout`, `two-factor/verify-two-factor.mjs`) — a budget `lib/auth/auth.ts` leaves at the
 * plugin's default rather than overriding, so this reasoning depends on it staying that way. Those
 * are the numbers an operator actually gets only because one submission reaches one endpoint. The
 * challenge cookie's own short life is not what bounds this: `signInLimiter.reset(address)` above
 * fires on every accepted password, so a password-holder can mint a fresh ten-minute challenge
 * indefinitely without ever tripping the address throttle. The account lockout is the real ceiling.
 *
 * @param _previous the prior form state, required by useActionState and unused
 * @param formData the submitted form
 * @returns the state to render, or never when the code is accepted and redirects
 */
export async function verifyTwoFactor(_previous: SignInState, formData: FormData): Promise<SignInState> {
	const submitted = formData.get("code");
	const code = typeof submitted === "string" ? submitted.trim() : "";

	if (code === "") {
		// Matches the malformed-submission branch in `signIn`: a direct POST with no `code` is a
		// submission this file's own header says to expect, and it should leave the same kind of
		// trace an empty email/password does there.
		await recordAudit({
			action: AUTH_AUDIT_ACTIONS.TWO_FACTOR,
			outcome: "DENIED",
			actor: unknownUserActor(""),
			detail: { reason: "malformed" },
			provenance: await requestProvenance(),
		});
		return { error: "Enter the code from your authenticator.", twoFactorRequired: true };
	}

	// Six digits and nothing else is a TOTP code; a recovery code carries a hyphen and letters. See
	// the note above for why the shape decides rather than a first attempt deciding.
	const looksLikeTotp = /^\d{6}$/.test(code);

	let verified: Awaited<ReturnType<typeof auth.api.verifyTOTP>> | Awaited<ReturnType<typeof auth.api.verifyBackupCode>>;
	try {
		verified = looksLikeTotp
			? await auth.api.verifyTOTP({ body: { code }, headers: await headers() })
			: await auth.api.verifyBackupCode({ body: { code }, headers: await headers() });
	} catch (error) {
		logger.warn("Failed two-factor attempt", {
			address: await getClientAddress(),
			// Which endpoint was tried, so the server log can tell a mistyped authenticator code from a
			// spent recovery code. The operator is told neither.
			factor: looksLikeTotp ? "totp" : "recovery-code",
			reason: error instanceof Error ? error.message : String(error),
		});
		await recordAudit({
			action: AUTH_AUDIT_ACTIONS.TWO_FACTOR,
			outcome: "DENIED",
			actor: unknownUserActor(""),
			detail: { reason: "rejected" },
			provenance: await requestProvenance(),
		});
		// No actor on the row. The challenge cookie is the only thing identifying the account at
		// this point and it is the plugin's; reading it here to name a user would couple this
		// action to an internal the plugin is free to change.
		return { error: "That code is not right.", twoFactorRequired: true };
	}

	await clearFailedSignIns(verified.user.id);

	// `verifyTOTP` and `verifyBackupCode` both rotate the session on success and both hand back the
	// new token, the same way `signInEmail` does on the password path — so the just-issued session is
	// pinned here for the same reason it is pinned there: without it, a cap of one could sort the
	// session just created behind an existing one on a coarse clock and sign the caller straight back
	// out of the session they just proved they own.
	const newSession = verified.token
		? await prisma.session.findUnique({ where: { token: verified.token }, select: { id: true } })
		: null;
	await enforceSessionCap(verified.user.id, newSession?.id ?? null);

	logger.info("Signed in with a second factor", { address: await getClientAddress() });
	await recordAudit({
		action: AUTH_AUDIT_ACTIONS.TWO_FACTOR,
		outcome: "SUCCESS",
		actor: userActor(verified.user),
		provenance: await requestProvenance(),
	});

	// Outside any try/catch: redirect() signals by throwing.
	redirect("/dashboard");
}
