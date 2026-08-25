"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { recordAudit, userActor } from "@/lib/audit/audit-log";
import { AUTH_AUDIT_ACTIONS } from "@/lib/audit/auth-events";
import { requestProvenance } from "@/lib/audit/provenance";
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
 * stays valid. Submission is not the whole story, though: if the holder never submits at all, that
 * window has no earlier cap and simply widens until it meets the same session-lifetime bound the
 * Settings form is defended against — submission is only the earlier of the two caps, not an
 * alternative to it.
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

	// `auth.api.setPassword` is the wrong endpoint for this: it throws `PASSWORD_ALREADY_SET`
	// (better-auth/dist/api/routes/update-user.mjs) the moment the account already has a
	// credential row, which every account reaching this page does — `setup.ts` writes
	// `account.password` directly, and nothing in this codebase creates a user without one. That
	// would make this page a dead end: refused on the one submission it exists to accept.
	// `auth.api.setUserPassword` (better-auth/dist/plugins/admin/routes.mjs) is built for exactly
	// this — it updates an existing credential instead of refusing it — but it runs behind the
	// admin plugin's `adminMiddleware` and a `user:["set-password"]` permission check, so the
	// caller's own session must already carry the "admin" role. Right now every account does:
	// `setup.ts` is the only place a user is created, and it always sets `role: "admin"`. Passing
	// the signed-in user's own id lets an account clear its own forced reset. This stops being true
	// the moment a later phase creates a non-admin account with "Require password reset" ticked —
	// tracked there, not fixed here.
	await auth.api.setUserPassword({
		body: { userId: user.id, newPassword: parsed.data },
		headers: await headers(),
	});

	// Cleared after the password is actually stored, not before. The other order would leave an
	// account free of the requirement but still holding the password it was told to replace, if
	// the write failed in between.
	await prisma.user.update({ where: { id: user.id }, data: { mustChangePassword: false } });

	logger.info("Required password change completed", { userId: user.id });

	// Nothing about the password goes in `detail`. Not its length, not its strength — the row
	// records that the account replaced it, which is the whole of what an investigation needs.
	await recordAudit({
		action: AUTH_AUDIT_ACTIONS.SET_PASSWORD,
		outcome: "SUCCESS",
		actor: userActor(user),
		provenance: await requestProvenance(),
	});

	// Outside any try/catch: redirect() signals by throwing.
	redirect("/dashboard");
}
