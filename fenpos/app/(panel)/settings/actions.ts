"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { ActionState } from "@/app/(panel)/agents/action-state";
import { setAdminPassword, setAdminProfile, verifyAdminPassword } from "@/lib/auth/admin";
import { passwordSchema } from "@/lib/auth/password";
import { MAXIMUM_DISPLAY_NAME_LENGTH } from "@/lib/auth/profile";
import { requireSession } from "@/lib/auth/require-session";
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
 * Changes the administrator password.
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
		if (!(await verifyAdminPassword(current))) {
			throw new ApiError("invalid_key", "That is not the current password.");
		}

		// Checked here rather than trusted from the form. The form disables its button on an
		// empty field, which stops a slip but not a direct call to this action — and a server
		// action is a public endpoint, so anything reachable only through the browser's
		// cooperation is not enforced at all.
		const minimumPasswordLength = await integerSetting("auth.minimumPasswordLength");
		const parsed = passwordSchema(minimumPasswordLength).safeParse(next);
		if (!parsed.success) {
			throw new ApiError("invalid_type", parsed.error.issues[0]?.message ?? "That password is not acceptable.");
		}

		const revoked = await setAdminPassword(parsed.data);
		logger.info("Administrator password changed", { sessionsRevoked: revoked });
	});
}

/**
 * Replaces the administrator's display name and email.
 *
 * No current-password check, unlike `changePassword`. Neither field is a credential and neither
 * can be used to sign in — asking for a password to change the name beside the avatar would be
 * ceremony that teaches an operator to type their password into any box that asks.
 *
 * The email is validated and stored as typed. Nothing sends mail yet, so a confirmation loop
 * would be theatre.
 *
 * @param displayName the new name
 * @param email the new address, or null/empty to remove it
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
			if (address !== "" && !z.email().safeParse(address).success) {
				throw new ApiError("invalid_type", "That is not a valid email address.");
			}

			await setAdminProfile({ displayName: name, email: address === "" ? null : address });
		},
		// The sidebar footer is in the layout, so refreshing a page would leave the name and the
		// avatar showing their old values until a hard reload.
		() => revalidatePath("/", "layout"),
	);
}
