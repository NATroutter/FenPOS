"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { z } from "zod";
import type { ActionState } from "@/app/(panel)/agents/action-state";
import { recordAudit, userActor } from "@/lib/audit/audit-log";
import { requestProvenance } from "@/lib/audit/provenance";
import { auth } from "@/lib/auth/auth";
import { userHolds } from "@/lib/auth/effective-permissions";
import { panelAction, panelQuery, panelSelf } from "@/lib/auth/panel-action";
import { hashPassword, passwordSchema } from "@/lib/auth/password";
import { assertNotReused, recordPasswordChange } from "@/lib/auth/password-history";
import { MAXIMUM_DISPLAY_NAME_LENGTH } from "@/lib/auth/password-policy";
import { PermissionDeniedError } from "@/lib/auth/require-permission";
import { beginEnrolment, confirmEnrolment, type Enrolment, endEnrolment } from "@/lib/auth/two-factor";
import { prisma } from "@/lib/db";
import type { PanelPermission } from "@/lib/domain/panel-permissions";
import { ApiError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { clearSetting, globalPasswordPolicy, SETTINGS, setSetting } from "@/lib/settings/settings-service";

/**
 * Server actions behind the Settings tab.
 *
 * Two of the three actions here are on the caller's own account and are deliberately ungated —
 * every authenticated user must be able to change their own password, and gating that one would
 * let somebody be locked out of the forced reset standing between them and the panel. They are
 * still recorded. The third, {@link saveSettings}, checks a permission per staged change.
 */

/**
 * The permission that governs changing one setting.
 *
 * Derived from the setting's own declared category rather than from its key prefix, because the
 * categories deliberately span prefixes — `auth.*` and `pairing.*` are both security. A key with no
 * definition has no category and therefore no permission that could allow it, so it is refused:
 * `setSetting` would reject it anyway, and refusing it here means the record says which of the two
 * happened.
 *
 * The cast rests on every `SettingCategory` having a matching `settings:write:<category>`
 * identifier, which `test/lib/domain/panel-permissions.test.ts` asserts directly — without it,
 * adding a category would silently make its settings superuser-only.
 *
 * @param key the setting key being changed
 * @returns the permission required, or null when nothing defines that key
 */
function permissionForSetting(key: string): PanelPermission | null {
	const definition = SETTINGS.find((candidate) => candidate.key === key);
	return definition ? (`settings:write:${definition.category}` as PanelPermission) : null;
}

/**
 * One staged change: a new value for a setting, or a return to its built-in default.
 *
 * A reset is its own kind rather than "set it to the fallback", because the two are different
 * stored states. Storing the fallback leaves a row behind that pins the value forever; clearing it
 * means "use whatever this version's default is", so an upgrade that improves a default reaches an
 * install that never touched it. The Settings page offers both and they must not collapse into one.
 */
export type SettingChange =
	| { key: string; kind: "set"; value: number | string | boolean }
	| { key: string; kind: "reset" };

/** Which staged changes failed, keyed by setting. Empty when every change applied. */
export interface SaveSettingsResult {
	errors: Record<string, string>;
}

/**
 * Applies a batch of staged changes.
 *
 * The Settings page stages edits and commits them together, so this takes the whole batch rather
 * than one setting at a time: one session check, one revalidation, and one round trip however many
 * knobs were turned.
 *
 * **Failures are per-setting, not per-batch.** A rejected value is a fact about that one setting —
 * usually a bound or a pattern — and refusing the other nine because of it would make an operator
 * redo work that was already acceptable. Each change is applied independently and the ones that
 * failed come back named, so the page can keep exactly those staged and clear the rest.
 *
 * **Refusals are per-setting too, and for the same reason.** The batch spans categories, and each
 * category has its own permission, so the caller's authority is checked once per change rather than
 * once per call — which is why this is the registry's one `custom` entry and does its own checking
 * instead of going through the shared gate. Without the split, whoever may change the Jobs-per-page
 * number could disable the IP allowlist in the same batch.
 *
 * The session is resolved here rather than trusted from the layout: an action is a POST endpoint in
 * its own right, callable by anyone who knows its id. `setSetting` and `clearSetting` do the
 * validation — the types on `SettingChange` are a shape, not a check.
 *
 * @param changes the staged changes, in the order they should be applied
 * @returns the setting keys that failed, each with the message to show against it
 */
export async function saveSettings(changes: SettingChange[]): Promise<SaveSettingsResult> {
	const user = await panelSelf("settings:save");

	const errors: Record<string, string> = {};
	const applied: string[] = [];
	const refused: string[] = [];

	for (const change of changes) {
		try {
			const permission = permissionForSetting(change.key);
			if (permission === null || !(await userHolds(user, permission))) {
				// Refused per change rather than per batch, matching how a rejected value already
				// behaves: refusing the other nine settings because of one would make an operator redo
				// work that was already acceptable.
				throw new PermissionDeniedError(permission ?? "settings:read");
			}
			if (change.kind === "reset") {
				await clearSetting(change.key);
			} else {
				await setSetting(change.key, change.value);
			}
			applied.push(change.key);
		} catch (error) {
			if (error instanceof PermissionDeniedError) {
				refused.push(change.key);
				errors[change.key] = error.message;
			} else if (error instanceof ApiError) {
				errors[change.key] = error.message;
			} else {
				logger.error("Settings action failed: save", error, { key: change.key });
				errors[change.key] = "Something went wrong. Check the server log.";
			}
		}
	}

	// One row for the batch rather than one per setting: the operator pressed Save once, and a row
	// per knob would make a routine edit look like a rampage. The keys are named, so the row still
	// says exactly what moved. Values are deliberately absent — a batch can carry
	// `server.publicUrl` today and credentials later, and the settings table holds what each became.
	await recordAudit({
		action: "settings:save",
		outcome: refused.length > 0 && applied.length === 0 ? "DENIED" : "SUCCESS",
		actor: userActor(user),
		detail: {
			applied,
			refused,
			failed: Object.keys(errors).filter((key) => !refused.includes(key)),
		},
		provenance: await requestProvenance(user.sessionId),
	});

	revalidatePath("/settings");
	return { errors };
}

/**
 * Changes the signed-in user's password.
 *
 * The current password is required even though the caller is already signed in. A session left
 * open on an unattended machine is the case this defends against, and it is a common one in a
 * back office.
 *
 * @param current the password in effect
 * @param next what to change it to
 * @returns the state to render
 */
export async function changePassword(current: string, next: string): Promise<ActionState> {
	return panelAction(
		"self:change-password",
		async (user) => {
			// Checked here rather than trusted from the form, and before Better Auth ever sees the
			// candidate: the form disables its button on an empty field, which stops a slip but not a
			// direct call to this action, and Better Auth's own `changePassword` enforces only its own
			// built-in bounds — it knows nothing about the install's configured
			// `auth.minimumPasswordLength`.
			const policy = await globalPasswordPolicy();
			const parsed = passwordSchema(policy).safeParse(next);
			if (!parsed.success) {
				throw new ApiError("invalid_type", parsed.error.issues[0]?.message ?? "That password is not acceptable.");
			}

			await assertNotReused(user.id, parsed.data);

			try {
				await auth.api.changePassword({
					body: { currentPassword: current, newPassword: parsed.data, revokeOtherSessions: true },
					headers: await headers(),
				});
			} catch {
				// Better Auth collapses every reason it might refuse this into one error, and from the
				// caller's side there is only one that matters: the current password they typed is not
				// the one on the account.
				throw new ApiError("invalid_key", "That is not the current password.");
			}

			// Recorded after Better Auth has stored it, because only then is it the account's password.
			// Better Auth hashes its own copy, so this is a second hash of the same string — argon2
			// salts each one, so the two differ by design and `verifyPassword` matches either.
			await recordPasswordChange(user.id, await hashPassword(parsed.data));

			logger.info("Password changed");
			// Nothing about the password reaches the record: not its length, not its strength. The row
			// says the account replaced it, which is the whole of what an investigation needs.
		},
		{ revalidate: () => revalidatePath("/settings") },
	);
}

/**
 * Replaces the signed-in user's display name and email.
 *
 * No current-password check, unlike `changePassword`. Neither field is a credential and neither
 * can be used to sign in — asking for a password to change the name beside the avatar would be
 * ceremony that teaches an operator to type their password into any box that asks.
 *
 * The email is validated and stored as typed. Nothing sends mail yet, so a confirmation loop
 * would be theatre. Unlike the single-administrator model this replaced, it may not be cleared to
 * empty: Better Auth requires every account to carry one, and the column is unique.
 *
 * @param displayName the new name
 * @param email the new address
 * @returns the state to render
 */
export async function updateProfile(displayName: string, email: string | null): Promise<ActionState> {
	const name = displayName.trim();
	const address = (email ?? "").trim();

	return panelAction(
		"self:update-profile",
		async (user) => {
			if (name === "") {
				throw new ApiError("missing_field", "A display name is required.");
			}
			if (name.length > MAXIMUM_DISPLAY_NAME_LENGTH) {
				throw new ApiError(
					"invalid_type",
					`Keep the display name to ${MAXIMUM_DISPLAY_NAME_LENGTH} characters or fewer.`,
				);
			}
			if (address === "") {
				throw new ApiError("missing_field", "An email address is required.");
			}
			if (!z.email().safeParse(address).success) {
				throw new ApiError("invalid_type", "That is not a valid email address.");
			}

			try {
				await prisma.user.update({ where: { id: user.id }, data: { name, email: address } });
			} catch (thrown) {
				// The check above only proves the address is well-formed, not that it is free — two
				// requests racing past that check is exactly what the column's own unique constraint
				// is for. Without this, the loser gets the gate's generic "check the server log"
				// instead of the one thing they could act on.
				if (isPrismaCode(thrown, "P2002")) {
					throw new ApiError("name_taken", "That email address is already in use.");
				}
				throw thrown;
			}
		},
		{
			// The sidebar footer is in the layout, so refreshing a page would leave the name and the
			// avatar showing their old values until a hard reload.
			revalidate: () => revalidatePath("/", "layout"),
			// Recorded in full: "who changed that account's email, and to what" is the question a
			// compromised-account investigation opens with.
			detail: { name, email: address },
		},
	);
}

/**
 * Whether a caught value is a Prisma error with the given code.
 *
 * @param error the caught value
 * @param code the Prisma error code to match, e.g. `P2002`
 * @returns true when the error carries that code
 */
function isPrismaCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

/** What the enrolment screen gets back: the material, or the reason there is none. */
export interface StartTwoFactorState {
	error: string | null;
	enrolment: Enrolment | null;
}

/**
 * Stores a secret for the caller's account and hands back the QR and recovery codes.
 *
 * `panelQuery` rather than `panelAction`, because the return value *is* the point — an
 * `ActionState` would leave nowhere to put the QR. `self:begin-2fa` is a `command` in everything but
 * the wrapper it uses, which is exactly the case `PanelActionKind`'s own note describes: the kind
 * decides what is recorded, the shape of the result decides which wrapper carries it.
 *
 * **Nothing about the enrolment reaches the audit row.** The registry description says the caller
 * started enrolment and stops there. A secret written into an append-only table is a secret with no
 * way back out.
 *
 * @param password the caller's current password
 * @returns the enrolment, or the reason there is none
 */
export async function startTwoFactor(password: string): Promise<StartTwoFactorState> {
	return panelQuery<StartTwoFactorState>(
		"self:begin-2fa",
		async () => ({ error: null, enrolment: await beginEnrolment(password) }),
		{
			refused: () => ({ error: "You cannot do that.", enrolment: null }),
			failed: (error) => ({
				error: error instanceof ApiError ? error.message : "Two-factor could not be set up.",
				enrolment: null,
			}),
		},
	);
}

/**
 * Accepts a code from the authenticator and turns the second factor on.
 *
 * A refused code is a `FAILURE` row rather than a silent retry: a run of them is either an operator
 * whose clock has drifted or somebody working through codes on an account they have a session for,
 * and both are worth being able to see.
 *
 * @param code the six digits the app is showing
 * @returns the state to render
 */
export async function confirmTwoFactor(code: string): Promise<ActionState> {
	return panelAction("self:confirm-2fa", () => confirmEnrolment(code), {
		revalidate: () => revalidatePath("/settings"),
	});
}

/**
 * Removes the caller's own second factor.
 *
 * @param password the caller's current password
 * @returns the state to render
 */
export async function stopTwoFactor(password: string): Promise<ActionState> {
	return panelAction("self:end-2fa", () => endEnrolment(password), {
		revalidate: () => revalidatePath("/settings"),
	});
}
