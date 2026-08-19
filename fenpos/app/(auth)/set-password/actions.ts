"use server";

import { redirect } from "next/navigation";
import { isPasswordGenerated, setAdminPassword } from "@/lib/auth/admin";
import { passwordSchema } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/session";
import { getCurrentSession, setSessionCookie } from "@/lib/auth/session-cookie";
import { logger } from "@/lib/logger";
import { getClientAddress, getUserAgent } from "@/lib/request-context";

/**
 * Replacing the generated password, which is the only thing a session can do until it has.
 */

/** What the form renders after a submission. */
export interface SetPasswordState {
	/** Message to display, or null before the first attempt. */
	error: string | null;
}

/**
 * Sets the administrator password and opens the panel.
 *
 * Requires a valid session, so only someone who already proved they hold the generated
 * password can reach it — this is a continuation of signing in, not a route that can claim an
 * unclaimed install. It also requires that the password still *is* the generated one, so the
 * page cannot be used to change a real password without knowing the current one; that lives
 * on Settings and asks for it.
 *
 * A fresh session is issued afterwards because setting the password revokes every existing
 * one, including the caller's. Without it the operator would be bounced back to sign-in
 * moments after choosing a password, which reads as a failure rather than success.
 *
 * @param _previous the prior form state, required by useActionState and unused
 * @param formData the submitted form
 * @returns the state to render, or never when the change succeeds and redirects
 */
export async function setPassword(_previous: SetPasswordState, formData: FormData): Promise<SetPasswordState> {
	if (!(await getCurrentSession())) {
		redirect("/login");
	}

	if (!(await isPasswordGenerated())) {
		// Already done, possibly in another tab. Nothing to do and nowhere to stay.
		redirect("/dashboard");
	}

	const password = formData.get("password");
	const confirm = formData.get("confirm");

	const parsed = passwordSchema.safeParse(password);
	if (!parsed.success) {
		return { error: parsed.error.issues[0]?.message ?? "That password is not acceptable." };
	}

	if (parsed.data !== confirm) {
		return { error: "The two passwords do not match." };
	}

	await setAdminPassword(parsed.data);

	const { token, expiresAt } = await createSession({
		ipAddress: await getClientAddress(),
		userAgent: await getUserAgent(),
	});
	await setSessionCookie(token, expiresAt);

	logger.info("Generated administrator password replaced");

	// Outside any try/catch: redirect() signals by throwing.
	redirect("/dashboard");
}
