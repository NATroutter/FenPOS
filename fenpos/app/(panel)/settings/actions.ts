"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/app/(panel)/agents/action-state";
import { setAdminPassword, verifyAdminPassword } from "@/lib/auth/admin";
import { passwordSchema } from "@/lib/auth/password";
import { requireSession } from "@/lib/auth/require-session";
import { ApiError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { clearSetting, setSetting } from "@/lib/settings/settings-service";

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
 * @returns the state to render
 */
async function run(label: string, work: () => Promise<void>): Promise<ActionState> {
	// Outside the try: an absent session redirects, and `redirect` signals by throwing. Catching
	// it here would turn being signed out into a toast over a panel that no longer works.
	await requireSession();

	try {
		await work();
		revalidatePath("/settings");
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
 * Stores a setting.
 *
 * @param key which setting
 * @param value the new value
 * @returns the state to render
 */
export async function saveSetting(key: string, value: number): Promise<ActionState> {
	return run("save", () => setSetting(key, value));
}

/**
 * Returns a setting to its built-in default.
 *
 * @param key which setting
 * @returns the state to render
 */
export async function resetSetting(key: string): Promise<ActionState> {
	return run("reset", () => clearSetting(key));
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
		const parsed = passwordSchema.safeParse(next);
		if (!parsed.success) {
			throw new ApiError("invalid_type", parsed.error.issues[0]?.message ?? "That password is not acceptable.");
		}

		const revoked = await setAdminPassword(parsed.data);
		logger.info("Administrator password changed", { sessionsRevoked: revoked });
	});
}
