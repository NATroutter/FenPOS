"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { z } from "zod";
import type { ActionState } from "@/app/(panel)/agents/action-state";
import { auth } from "@/lib/auth/auth";
import { passwordSchema } from "@/lib/auth/password";
import { MAXIMUM_DISPLAY_NAME_LENGTH } from "@/lib/auth/password-policy";
import { requireSession } from "@/lib/auth/require-session";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { clearSetting, integerSetting, setSetting } from "@/lib/settings/settings-service";

/**
 * Server actions behind the Settings tab.
 *
 * The session is re-checked here rather than trusted from the layout: an action is a POST
 * endpoint in its own right, callable by anyone who knows its id.
 */

/**
 * Runs an action, converting a failure into a message the panel can render.
 *
 * @param label short description used in the log line
 * @param work the action body
 * @param revalidate what to refresh on success. Defaults to the Settings page, which is what
 *   every action on that page wants; the profile action refreshes the layout instead, because
 *   the name and avatar it changes are rendered by the sidebar rather than by any page.
 * @returns the state to render
 */
async function run(
	label: string,
	work: () => Promise<void>,
	revalidate: () => void = () => revalidatePath("/settings"),
): Promise<ActionState> {
	// Outside the try: an absent session redirects, and `redirect` signals by throwing. Catching
	// it here would turn being signed out into a toast over a panel that no longer works.
	await requireSession();

	try {
		await work();
		revalidate();
		return { error: null };
	} catch (error) {
		if (error instanceof ApiError) {
			return { error: error.message };
		}
		logger.error(`Settings action failed: ${label}`, error);
		return { error: "Something went wrong. Check the server log." };
	}
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
 * The session is re-checked here rather than trusted from the layout: an action is a POST endpoint
 * in its own right, callable by anyone who knows its id. `setSetting` and `clearSetting` do the
 * validation — the types on `SettingChange` are a shape, not a check.
 *
 * @param changes the staged changes, in the order they should be applied
 * @returns the setting keys that failed, each with the message to show against it
 */
export async function saveSettings(changes: SettingChange[]): Promise<SaveSettingsResult> {
	await requireSession();

	const errors: Record<string, string> = {};

	for (const change of changes) {
		try {
			if (change.kind === "reset") {
				await clearSetting(change.key);
			} else {
				await setSetting(change.key, change.value);
			}
		} catch (error) {
			if (error instanceof ApiError) {
				errors[change.key] = error.message;
			} else {
				logger.error("Settings action failed: save", error, { key: change.key });
				errors[change.key] = "Something went wrong. Check the server log.";
			}
		}
	}

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
	return run("password", async () => {
		// Checked here rather than trusted from the form, and before Better Auth ever sees the
		// candidate: the form disables its button on an empty field, which stops a slip but not a
		// direct call to this action, and Better Auth's own `changePassword` enforces only its own
		// built-in bounds — it knows nothing about the install's configured
		// `auth.minimumPasswordLength`.
		const minimumPasswordLength = await integerSetting("auth.minimumPasswordLength");
		const parsed = passwordSchema(minimumPasswordLength).safeParse(next);
		if (!parsed.success) {
			throw new ApiError("invalid_type", parsed.error.issues[0]?.message ?? "That password is not acceptable.");
		}

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

		logger.info("Password changed");
	});
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
	return run(
		"update profile",
		async () => {
			const name = displayName.trim();
			const address = (email ?? "").trim();

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

			const { id } = await requireSession();

			try {
				await prisma.user.update({ where: { id }, data: { name, email: address } });
			} catch (thrown) {
				// The check above only proves the address is well-formed, not that it is free — two
				// requests racing past that check is exactly what the column's own unique constraint
				// is for. Without this, the loser gets `run()`'s generic "check the server log"
				// instead of the one thing they could act on.
				if (isPrismaCode(thrown, "P2002")) {
					throw new ApiError("name_taken", "That email address is already in use.");
				}
				throw thrown;
			}
		},
		// The sidebar footer is in the layout, so refreshing a page would leave the name and the
		// avatar showing their old values until a hard reload.
		() => revalidatePath("/", "layout"),
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
