"use server";

import { redirect } from "next/navigation";
import { recordAudit, userActor } from "@/lib/audit/audit-log";
import { AUTH_AUDIT_ACTIONS } from "@/lib/audit/auth-events";
import { requestProvenance } from "@/lib/audit/provenance";
import { CREDENTIAL_ISSUER } from "@/lib/auth/credential-account";
import { hashPassword, passwordSchema } from "@/lib/auth/password";
import { assertNotReused, recordPasswordChange } from "@/lib/auth/password-history";
import { currentUser } from "@/lib/auth/require-session";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { globalPasswordPolicy } from "@/lib/settings/settings-service";

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

	const policy = await globalPasswordPolicy();
	const parsed = passwordSchema(policy).safeParse(password);
	if (!parsed.success) {
		return { error: parsed.error.issues[0]?.message ?? "That password is not acceptable." };
	}

	if (parsed.data !== confirm) {
		return { error: "The two passwords do not match." };
	}

	// The path that matters most for reuse: an account sent here *because its password expired* must
	// not be able to set the same one straight back.
	try {
		await assertNotReused(user.id, parsed.data);
	} catch (error) {
		return { error: error instanceof ApiError ? error.message : "That password is not acceptable." };
	}

	// Neither `auth.api.setPassword` nor `auth.api.setUserPassword` will do here.
	// `auth.api.setPassword` (better-auth/dist/api/routes/update-user.mjs) throws
	// `PASSWORD_ALREADY_SET` the moment the account already has a credential row, which every
	// account reaching this page does — `setup.ts` and `account-service.ts` both write
	// `account.password` directly, and nothing in this codebase creates a user without one. That
	// would make this page a dead end: refused on the one submission it exists to accept.
	// `auth.api.setUserPassword` (better-auth/dist/plugins/admin/routes.mjs) runs behind the admin
	// plugin's `adminMiddleware`, which checks the caller's own session role against `adminRoles`
	// (default `["admin"]`) — and `account-service.ts` makes `"user"` the default role for every
	// panel-made account, so that endpoint refuses exactly the callers this page exists to unblock.
	// Nor is this `setAccountPassword` (`lib/auth/account-security.ts`): that function ends every
	// session the account holds, and the caller's own current session is one of them — the
	// `redirect("/dashboard")` below would then bounce straight back to `/login`. So this writes the
	// credential row directly instead, matching `setAccountPassword`'s own write: the row is found
	// by `{ userId, issuer: CREDENTIAL_ISSUER }` rather than a key Prisma can address, so
	// `updateMany` rather than `update`, and its count is checked so an account with no credential
	// is reported rather than silently left with the password it had.
	const passwordHash = await hashPassword(parsed.data);
	const { count } = await prisma.account.updateMany({
		where: { userId: user.id, issuer: CREDENTIAL_ISSUER },
		data: { password: passwordHash, updatedAt: new Date() },
	});
	if (count === 0) {
		return { error: "That account has no password to replace." };
	}

	// Recorded after the store, for the same reason the flag is cleared after it. The hash passed
	// here is the same one just written above, not a second call to `hashPassword` — nothing needs
	// two independently salted hashes of the same password, only the one that is now on the row.
	await recordPasswordChange(user.id, passwordHash);

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
