"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { recordAudit, SETUP_ACTOR } from "@/lib/audit/audit-log";
import { AUTH_AUDIT_ACTIONS } from "@/lib/audit/auth-events";
import { requestProvenance } from "@/lib/audit/provenance";
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
		await recordAudit({
			action: AUTH_AUDIT_ACTIONS.SETUP_KEY,
			outcome: "DENIED",
			actor: SETUP_ACTOR,
			detail: { reason: "rate-limited", retryAfterSeconds: seconds },
			provenance: await requestProvenance(),
		});
		return { error: `Too many attempts. Try again in ${seconds} seconds.` };
	}

	const setupKey = formData.get("setupKey");
	if (typeof setupKey !== "string" || !(await verifySetupKey(setupKey)) || (await isInstallClaimed())) {
		logger.warn("Rejected setup key", { address, remainingAttempts: limit.remaining });
		// The submitted key never goes in `detail`. `setupKey` is on the redaction list, so a mistake
		// here would be caught — but a backstop is not a reason to hand it one.
		await recordAudit({
			action: AUTH_AUDIT_ACTIONS.SETUP_KEY,
			outcome: "DENIED",
			actor: SETUP_ACTOR,
			detail: { reason: "rejected", remainingAttempts: limit.remaining },
			provenance: await requestProvenance(),
		});
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
		await recordAudit({
			action: AUTH_AUDIT_ACTIONS.SETUP_COMPLETE,
			outcome: "DENIED",
			actor: SETUP_ACTOR,
			detail: { reason: "rate-limited", retryAfterSeconds: seconds },
			provenance: await requestProvenance(),
		});
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
		await recordAudit({
			action: AUTH_AUDIT_ACTIONS.SETUP_COMPLETE,
			outcome: "DENIED",
			actor: SETUP_ACTOR,
			detail: { reason: "malformed" },
			provenance: await requestProvenance(),
		});
		return { error: REJECTION_MESSAGE };
	}

	try {
		const { userId } = await completeSetup({ setupKey, name, email, password });

		// Last statement of the try, so the claim is recorded even if the convenience sign-in below
		// fails. Sitting inside a try is safe here in a way it would not be for other code:
		// `recordAudit` does not throw, so there is nothing for the catch to swallow.
		await recordAudit({
			action: AUTH_AUDIT_ACTIONS.SETUP_COMPLETE,
			outcome: "SUCCESS",
			actor: SETUP_ACTOR,
			// Normalised the same way `completeSetup` normalises it before storing, so the row and
			// the account agree about the address.
			target: { kind: "user", id: userId, label: email.trim().toLowerCase() },
			provenance: await requestProvenance(),
		});
	} catch (error) {
		if (error instanceof ApiError) {
			// A `SetupRefusedError` carries the single indistinguishable message; anything else here
			// is one of `completeSetup`'s own validation failures (a missing name, a missing email, a
			// password that fails `passwordSchema`) and is shown as its own text. That might look
			// like it depends on the caller having already proved they hold the key, but it does not:
			// `completeSetup` runs these validations before it opens the transaction that checks the
			// key, so a wrong or absent key can reach one of these messages too. What actually makes
			// them safe to disclose is that they fire unconditionally — the same message for the same
			// malformed input whether the key is right, wrong, or the install is already claimed — so
			// showing one discloses nothing about either.
			logger.warn("Setup refused", { address, reason: error.message });
			await recordAudit({
				action: AUTH_AUDIT_ACTIONS.SETUP_COMPLETE,
				outcome: "DENIED",
				actor: SETUP_ACTOR,
				detail: { reason: "refused" },
				provenance: await requestProvenance(),
			});
			return { error: error.message };
		}
		logger.error("Setup failed unexpectedly", error, { address });
		// The one FAILURE in this file: something broke, rather than someone being refused.
		await recordAudit({
			action: AUTH_AUDIT_ACTIONS.SETUP_COMPLETE,
			outcome: "FAILURE",
			actor: SETUP_ACTOR,
			detail: { reason: "unexpected" },
			provenance: await requestProvenance(),
		});
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
