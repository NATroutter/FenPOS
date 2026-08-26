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
import { prisma } from "@/lib/db";
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

/** What the form renders after a submission. */
export interface SignInState {
	/** Message to display, or null before the first attempt. */
	error: string | null;
	/**
	 * True once the password has been accepted and a second factor is owed.
	 *
	 * The form swaps its fields on this rather than navigating. The plugin's own challenge cookie is
	 * what actually carries the state between the two submissions, so a refresh loses the *screen*
	 * and not the *challenge* — signing in again lands on the same step.
	 */
	twoFactorRequired: boolean;
}

/** Shown for every failure, whatever its cause. */
const REJECTION_MESSAGE = "That email address and password do not match an account.";

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
 * banned account, and a malformed submission all produce the same message. Telling them apart
 * would disclose which addresses hold accounts on this install, which is useful only to someone
 * who should not be here. The server log records the difference.
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
		// Counted against the account rather than the address. A ban, a wrong password and an unknown
		// address all land here, and `recordFailedSignIn` is silent about the last of those.
		await recordFailedSignIn(email);
		logger.warn("Failed sign-in attempt", {
			address,
			email: email.trim().toLowerCase(),
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
		await recordAudit({
			action: AUTH_AUDIT_ACTIONS.SIGN_IN,
			outcome: "SUCCESS",
			actor: unknownUserActor(readEmail(formData)),
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
 * lengths and the plugin can tell them apart, so this tries the authenticator first and falls back.
 *
 * Deliberately **not** rate-limited by address the way the password step is: the throttle was
 * already cleared when the password was accepted, and an attacker who has reached this step holds a
 * valid password, so the thing worth counting is codes against this challenge rather than requests
 * from this address. The challenge cookie the plugin issued is short-lived, which is what bounds it.
 * If a run of `auth:two-factor` DENIED rows ever shows this being ground at, a per-challenge counter
 * is the fix, not a per-address one.
 *
 * @param _previous the prior form state, required by useActionState and unused
 * @param formData the submitted form
 * @returns the state to render, or never when the code is accepted and redirects
 */
export async function verifyTwoFactor(_previous: SignInState, formData: FormData): Promise<SignInState> {
	const submitted = formData.get("code");
	const code = typeof submitted === "string" ? submitted.trim() : "";

	if (code === "") {
		return { error: "Enter the code from your authenticator.", twoFactorRequired: true };
	}

	let verified: Awaited<ReturnType<typeof auth.api.verifyTOTP>> | Awaited<ReturnType<typeof auth.api.verifyBackupCode>>;
	try {
		verified = await auth.api.verifyTOTP({ body: { code }, headers: await headers() });
	} catch {
		try {
			verified = await auth.api.verifyBackupCode({ body: { code }, headers: await headers() });
		} catch (error) {
			logger.warn("Failed two-factor attempt", {
				address: await getClientAddress(),
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
