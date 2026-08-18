"use server";

import { redirect } from "next/navigation";
import { verifyAdminPassword } from "@/lib/auth/admin";
import { signInLimiter } from "@/lib/auth/rate-limit";
import { createSession } from "@/lib/auth/session";
import { setSessionCookie } from "@/lib/auth/session-cookie";
import { logger } from "@/lib/logger";
import { getClientAddress, getUserAgent } from "@/lib/request-context";

/**
 * Sign-in.
 *
 * Every check runs on the server. The form does no validation that matters, because a form
 * is not a security boundary — anything the browser enforces can be skipped by posting
 * directly to this action.
 */

/** What the form renders after a submission. */
export interface SignInState {
	/** Message to display, or null before the first attempt. */
	error: string | null;
}

/** Shown for both a wrong password and an unconfigured install. */
const REJECTION_MESSAGE = "That password is not correct.";

/**
 * Verifies the administrator password and starts a session.
 *
 * Failures are deliberately indistinguishable to the caller: a wrong password, a malformed
 * submission, and an install with no administrator configured all produce the same message.
 * Telling them apart would disclose whether the install has been bootstrapped, which is
 * useful only to someone who should not be here. The server log records the difference.
 *
 * @param _previous the prior form state, required by useActionState and unused
 * @param formData the submitted form
 * @returns the state to render, or never when sign-in succeeds and redirects
 */
export async function signIn(_previous: SignInState, formData: FormData): Promise<SignInState> {
	const address = await getClientAddress();

	// Consumed before the password is examined, so that attempts are counted whether or not
	// the submission is well-formed.
	const limit = signInLimiter.consume(address);
	if (!limit.allowed) {
		const seconds = Math.ceil(limit.retryAfterMs / 1000);
		logger.warn("Sign-in rate limit engaged", { address, retryAfterSeconds: seconds });
		return { error: `Too many attempts. Try again in ${seconds} seconds.` };
	}

	const password = formData.get("password");
	if (typeof password !== "string" || password.length === 0) {
		return { error: REJECTION_MESSAGE };
	}

	if (!(await verifyAdminPassword(password))) {
		logger.warn("Failed sign-in attempt", { address, remainingAttempts: limit.remaining });
		return { error: REJECTION_MESSAGE };
	}

	// A legitimate operator who mistyped twice should not stay throttled for the rest of the
	// window once they get it right.
	signInLimiter.reset(address);

	const { token, expiresAt } = await createSession({
		ipAddress: address,
		userAgent: await getUserAgent(),
	});
	await setSessionCookie(token, expiresAt);

	logger.info("Administrator signed in", { address });

	// Outside the try/catch that would otherwise swallow it: redirect() signals by throwing.
	redirect("/dashboard");
}
