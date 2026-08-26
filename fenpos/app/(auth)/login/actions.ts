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
		return { error: REJECTION_MESSAGE };
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
		return { error: `Too many attempts. Try again in ${seconds} seconds.` };
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
		return { error: REJECTION_MESSAGE };
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
		return { error: REJECTION_MESSAGE };
	}

	let signedIn: { user: { id: string; name: string; email: string } };
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
		return { error: REJECTION_MESSAGE };
	}

	// A legitimate operator who mistyped twice should not stay throttled for the rest of the
	// window once they get it right — nor stay one failure away from a lock.
	signInLimiter.reset(address);
	await clearFailedSignIns(signedIn.user.id);

	// After the session exists, so the new one is counted and protected. The session id is not
	// available here — `signInEmail` returns a token rather than a row — so nothing is pinned, and
	// the newest session survives on its stamp alone. It was written milliseconds ago; every other
	// session the account holds was written on a different request.
	await enforceSessionCap(signedIn.user.id, null);

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
