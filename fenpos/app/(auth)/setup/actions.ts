"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth/auth";
import { setupLimiter } from "@/lib/auth/rate-limit";
import { completeSetup } from "@/lib/auth/setup";
import { isInstallClaimed, verifySetupKey } from "@/lib/auth/setup-key";
import { ApiError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { getClientAddress } from "@/lib/request-context";

/**
 * First-run setup.
 *
 * Every check that matters runs in `lib/auth/setup.ts`. These actions exist to carry a form's
 * worth of input to it and to turn its refusals into something a person can read — they are not
 * the boundary, and nothing here may be relied on as one.
 */

/** What either form renders after a submission. */
export interface SetupState {
	/** Message to display, or null before the first attempt. */
	error: string | null;
}

/** Shown for every refusal, whatever its cause. */
const REJECTION_MESSAGE = "That setup key is not correct.";

/**
 * Checks a setup key without consuming it, so the form can move to its second step.
 *
 * Splitting the key from the account details is a usability choice with no security content: the
 * key is checked again, inside the transaction, when {@link runSetup} runs. Passing this action
 * proves nothing and grants nothing — it only avoids making an operator fill in a whole account
 * form before being told the key was mistyped.
 *
 * @param _previous the prior form state, required by useActionState and unused
 * @param formData the submitted form, carrying `setupKey`
 * @returns the state to render
 */
export async function checkSetupKey(_previous: SetupState, formData: FormData): Promise<SetupState> {
	const address = await getClientAddress();

	// Consumed before the key is examined, so attempts are counted whether or not the submission
	// is well-formed. The same ordering `signIn` and the pairing endpoint use.
	const limit = setupLimiter.consume(address);
	if (!limit.allowed) {
		const seconds = Math.ceil(limit.retryAfterMs / 1000);
		logger.warn("Setup key rate limit engaged", { address, retryAfterSeconds: seconds });
		return { error: `Too many attempts. Try again in ${seconds} seconds.` };
	}

	const setupKey = formData.get("setupKey");
	if (typeof setupKey !== "string" || !(await verifySetupKey(setupKey)) || (await isInstallClaimed())) {
		logger.warn("Rejected setup key", { address, remainingAttempts: limit.remaining });
		return { error: REJECTION_MESSAGE };
	}

	setupLimiter.reset(address);
	return { error: null };
}

/**
 * Claims the install and signs the new superuser in.
 *
 * The sign-in afterwards is what makes this read as success rather than as a form that emptied
 * itself: the operator has just chosen a password, and asking them to type it again immediately
 * would be ceremony. It is called with this request's own headers — not an empty `Headers` —
 * because Better Auth reads the request to attach the new session cookie to the response; without
 * a real request context, no cookie would be set and the redirect below would land the operator
 * back on `/login` looking signed out.
 *
 * @param _previous the prior form state, required by useActionState and unused
 * @param formData the submitted form
 * @returns the state to render, or never when setup succeeds and redirects
 */
export async function runSetup(_previous: SetupState, formData: FormData): Promise<SetupState> {
	const address = await getClientAddress();

	const limit = setupLimiter.consume(address);
	if (!limit.allowed) {
		const seconds = Math.ceil(limit.retryAfterMs / 1000);
		logger.warn("Setup rate limit engaged", { address, retryAfterSeconds: seconds });
		return { error: `Too many attempts. Try again in ${seconds} seconds.` };
	}

	const setupKey = formData.get("setupKey");
	const name = formData.get("name");
	const email = formData.get("email");
	const password = formData.get("password");

	if (
		typeof setupKey !== "string" ||
		typeof name !== "string" ||
		typeof email !== "string" ||
		typeof password !== "string"
	) {
		return { error: REJECTION_MESSAGE };
	}

	try {
		await completeSetup({ setupKey, name, email, password });
	} catch (error) {
		if (error instanceof ApiError) {
			// A `SetupRefusedError` already carries the single indistinguishable message; a
			// validation failure carries its own, which is safe to show because the caller has
			// already proved they hold the key by getting past the seal's first condition.
			logger.warn("Setup refused", { address, reason: error.message });
			return { error: error.message };
		}
		logger.error("Setup failed unexpectedly", error, { address });
		return { error: "Something went wrong. Check the server log." };
	}

	setupLimiter.reset(address);

	await auth.api.signInEmail({
		body: { email: email.trim().toLowerCase(), password },
		headers: await headers(),
	});

	// Outside any try/catch: redirect() signals by throwing.
	redirect("/dashboard");
}
