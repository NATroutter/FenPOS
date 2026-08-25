"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth/auth";
import { consumeSignInAttempt, signInLimiter } from "@/lib/auth/rate-limit";
import { logger } from "@/lib/logger";
import { getClientAddress } from "@/lib/request-context";

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
 * @param _previous the prior form state, required by useActionState and unused
 * @param formData the submitted form
 * @returns the state to render, or never when sign-in succeeds and redirects
 */
export async function signIn(_previous: SignInState, formData: FormData): Promise<SignInState> {
	const address = await getClientAddress();

	// Consumed before the credentials are examined, so attempts are counted whether or not the
	// submission is well-formed.
	const limit = await consumeSignInAttempt(address);
	if (!limit.allowed) {
		const seconds = Math.ceil(limit.retryAfterMs / 1000);
		logger.warn("Sign-in rate limit engaged", { address, retryAfterSeconds: seconds });
		return { error: `Too many attempts. Try again in ${seconds} seconds.` };
	}

	const email = formData.get("email");
	const password = formData.get("password");

	if (typeof email !== "string" || email.trim() === "" || typeof password !== "string" || password.length === 0) {
		return { error: REJECTION_MESSAGE };
	}

	try {
		await auth.api.signInEmail({
			body: { email: email.trim().toLowerCase(), password },
			headers: await headers(),
		});
	} catch (error) {
		logger.warn("Failed sign-in attempt", {
			address,
			email: email.trim().toLowerCase(),
			remainingAttempts: limit.remaining,
			reason: error instanceof Error ? error.message : String(error),
		});
		return { error: REJECTION_MESSAGE };
	}

	// A legitimate operator who mistyped twice should not stay throttled for the rest of the
	// window once they get it right.
	signInLimiter.reset(address);

	logger.info("Signed in", { address, email: email.trim().toLowerCase() });

	// Outside the try/catch that would otherwise swallow it: redirect() signals by throwing.
	redirect("/dashboard");
}
