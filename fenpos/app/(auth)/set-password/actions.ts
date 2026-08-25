"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth/auth";
import { passwordSchema } from "@/lib/auth/password";
import { currentUser } from "@/lib/auth/require-session";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { integerSetting } from "@/lib/settings/settings-service";

/**
 * Replacing a password the account is required to change.
 *
 * Reached when `mustChangePassword` is set — at first sign-in on an account created with "Require
 * password reset" ticked, or after an administrator forced a reset. A session in that state
 * reaches nothing else, which is enforced in `require-session.ts` rather than here, so a URL typed
 * into the address bar is caught too.
 */

/** What the form renders after a submission. */
export interface SetPasswordState {
	/** Message to display, or null before the first attempt. */
	error: string | null;
}

/**
 * Sets the caller's password and clears the requirement.
 *
 * No current-password check here, unlike the Settings form. The caller proved they hold the
 * current password moments earlier, by signing in with it — this page is the direct continuation
 * of that sign-in, not a general session being reused for a sensitive action, which is the case
 * the Settings form's check defends against: a session that has sat open, doing ordinary panel
 * work, for however long its lifetime allows. A session held here has no other page it could have
 * been left open on, so the window this check would close is bounded by the moment between
 * signing in and submitting this form — not, as it is on Settings, by how long the session itself
 * stays valid.
 *
 * Refuses a caller who owes no change, so this cannot become a route to changing a password
 * without knowing the current one.
 *
 * @param _previous the prior form state, required by useActionState and unused
 * @param formData the submitted form
 * @returns the state to render, or never when the change succeeds and redirects
 */
export async function setPassword(_previous: SetPasswordState, formData: FormData): Promise<SetPasswordState> {
	const user = await currentUser();
	if (!user) {
		redirect("/login");
	}

	if (!user.mustChangePassword) {
		// Already done, possibly in another tab, or reached by someone who was never asked.
		// Nothing to do and nowhere to stay.
		redirect("/dashboard");
	}

	const password = formData.get("password");
	const confirm = formData.get("confirm");

	const minimumPasswordLength = await integerSetting("auth.minimumPasswordLength");
	const parsed = passwordSchema(minimumPasswordLength).safeParse(password);
	if (!parsed.success) {
		return { error: parsed.error.issues[0]?.message ?? "That password is not acceptable." };
	}

	if (parsed.data !== confirm) {
		return { error: "The two passwords do not match." };
	}

	await auth.api.setPassword({ body: { newPassword: parsed.data }, headers: await headers() });

	// Cleared after the password is actually stored, not before. The other order would leave an
	// account free of the requirement but still holding the password it was told to replace, if
	// the write failed in between.
	await prisma.user.update({ where: { id: user.id }, data: { mustChangePassword: false } });

	logger.info("Required password change completed", { userId: user.id });

	// Outside any try/catch: redirect() signals by throwing.
	redirect("/dashboard");
}
