"use server";

import { revalidatePath } from "next/cache";
import {
	banAccount,
	clearTwoFactor,
	listAccountSessions,
	requirePasswordChange,
	revokeAccountSession,
	revokeAccountSessions,
	setAccountPassword,
	unbanAccount,
} from "@/lib/auth/account-security";
import { createAccount, deleteAccount, setAccountSuperuser, updateAccount } from "@/lib/auth/account-service";
import { readAvatarForm } from "@/lib/auth/avatar-form";
import type { CropRect } from "@/lib/auth/avatar-image";
import { removeAvatar, setAvatar } from "@/lib/auth/avatar-service";
import { setAccountPermissions, setAccountRoles } from "@/lib/auth/grant-service";
import { panelAction, panelQuery } from "@/lib/auth/panel-action";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/errors";
import type { ActionState } from "@/lib/panel/action-state";

/**
 * Server actions behind the Users tab.
 *
 * Every one goes through the shared gate, which resolves the session, checks the permission its
 * registry entry names, runs the body, and records the attempt. The bodies themselves are thin: the
 * rules live in `lib/auth/account-service.ts`, `account-security.ts` and `grant-service.ts`, because
 * they have to hold whether they are reached from here, from a test, or from the phase 8 recovery
 * CLI — an action is a place a rule is called, not a place it lives.
 *
 * **No password ever reaches `detail`.** Not its length, not a hint, not the field it arrived in.
 * `recordAudit` redacts by exact key name and would not know to strip an unnamed one, so nothing
 * here passes it. What is recorded is that the account's password was replaced, which is the whole
 * of what an investigation needs.
 */

/** What every action here refreshes on success. */
const revalidate = () => revalidatePath("/users");

/**
 * What the two avatar actions refresh: this tab, and the layout under it.
 *
 * The sidebar footer draws the signed-in operator's own picture and lives in the layout, which is
 * exactly why `setOwnAvatar` and `removeOwnAvatar` in `(panel)/settings/actions.ts` revalidate the
 * layout rather than a page. This pair needs it for the same reason: {@link setUserAvatar}'s own doc
 * says an administrator changing their *own* avatar through the Users tab is deliberately permitted,
 * and refreshing `/users` alone would leave that administrator's sidebar showing the previous
 * picture until a hard reload. {@link setSuperuser} makes the same two calls inline, for the same
 * reason on a different field.
 */
const revalidateAvatar = () => {
	revalidatePath("/users");
	revalidatePath("/", "layout");
};

/** The creation form's contents, as they cross the wire. Their rules live in `account-service.ts`. */
export interface NewUserInput {
	name: string;
	email: string;
	password: string;
	/** The "Require password reset" checkbox. */
	requirePasswordReset: boolean;
	roleIds: string[];
	permissions: string[];
}

/** One of an account's sessions, as the dialog lists it. */
export interface UserSession {
	id: string;
	ipAddress: string | null;
	userAgent: string | null;
	createdAt: string;
	updatedAt: string;
	expiresAt: string;
}

/**
 * Names an account in the audit row.
 *
 * Read before the action runs, so a row describing a deletion still says which address was deleted —
 * afterwards there is nothing left to look up. Falls back to the id alone when the account is
 * already gone, which is a fact worth recording rather than a reason to fail.
 *
 * @param userId the account being acted on
 * @returns the row's `target`
 */
async function accountTarget(userId: string): Promise<{ kind: string; id: string; label: string | null }> {
	const account = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
	return { kind: "user", id: userId, label: account?.email ?? null };
}

/**
 * Creates an account.
 *
 * @param input the form's contents
 * @returns the state to render
 */
export async function createUser(input: NewUserInput): Promise<ActionState> {
	// The body returns the new id and the wrapper's body returns nothing, so the id is dropped here
	// rather than by threading a second result shape through a wrapper that has no use for one.
	return panelAction(
		"users:create",
		async (user) => {
			await createAccount(user, input);
		},
		{
			revalidate,
			target: { kind: "user", label: input.email },
			// What it may do, never how it signs in.
			detail: {
				email: input.email,
				requirePasswordReset: input.requirePasswordReset,
				roles: input.roleIds.length,
				permissions: input.permissions,
			},
		},
	);
}

/**
 * Changes another account's display name and email.
 *
 * @param userId the account to change
 * @param name the new display name
 * @param email the new address
 * @returns the state to render
 */
export async function updateUser(userId: string, name: string, email: string): Promise<ActionState> {
	return panelAction("users:update", () => updateAccount(userId, name, email), {
		revalidate,
		target: await accountTarget(userId),
		// Recorded in full: an address change is how an account is taken over, and "to what" is the
		// first thing anyone investigating one asks.
		detail: { name, email },
	});
}

/**
 * Sets another account's avatar.
 *
 * Gated on `users:update`, deliberately, unlike `setOwnAvatar` in `(panel)/settings/actions.ts`. The
 * spec's "not gated" list covers only actions on your *own* account, and setting somebody else's
 * picture is not on it — this is the plan's one deliberate widening beyond the spec, and it gets the
 * same care as every other `users:*` action beside it: a real permission, and a `DENIED` row when
 * refused.
 *
 * The form is parsed *inside* the gated body, not before it, for the reason `setOwnAvatar` gives:
 * `readAvatarForm` can throw (a missing file, a non-integer coordinate, too many bytes), and a throw
 * from outside `panelAction`'s own `try` would escape as an unhandled rejection instead of the
 * `ActionState` a refused form is supposed to render.
 *
 * The avatar is written against `userId` — the argument — never against the acting administrator's
 * own id. Nothing here special-cases the acting account the way `banUser`/`deleteUser` refuse to act
 * on it, matching `updateUser` just above: an administrator changing their own avatar through this
 * path is no different from changing their own name here, and either is also reachable through the
 * ungated `self:*` pair regardless.
 *
 * @param userId the account whose avatar is being set
 * @param formData the file, and the crop rectangle as three integers
 * @returns the state to render
 */
export async function setUserAvatar(userId: string, formData: FormData): Promise<ActionState> {
	// Populated from inside the body, once the crop is actually known — see `setOwnAvatar`'s own doc
	// for why this is safe: `panel-action.ts`'s `record()` spreads `options.detail` only after
	// `work()` has returned or thrown, so a mutation made partway through the body still reaches the
	// row it writes. `userId` is set up front since it is known before the body runs; `crop` joins it
	// only once the store has actually accepted the image.
	const detail: { userId: string; crop?: CropRect } = { userId };

	return panelAction(
		"users:set-avatar",
		async () => {
			const { bytes, crop } = await readAvatarForm(formData);
			await setAvatar(userId, bytes, crop);
			detail.crop = crop;
		},
		{
			revalidate: revalidateAvatar,
			target: await accountTarget(userId),
			// The bytes are emphatically not recorded, same as `setOwnAvatar`: an audit row is a
			// permanent, hash-chained record and an avatar is megabytes of it. The target account and
			// the crop are small and say what changed.
			detail,
		},
	);
}

/**
 * Removes another account's avatar, falling its row back to the initial.
 *
 * @param userId the account whose avatar is being removed
 * @returns the state to render
 */
export async function removeUserAvatar(userId: string): Promise<ActionState> {
	return panelAction(
		"users:remove-avatar",
		async () => {
			await removeAvatar(userId);
		},
		{
			revalidate: revalidateAvatar,
			target: await accountTarget(userId),
			detail: { userId },
		},
	);
}

/**
 * Sets another account's password, ending its sessions.
 *
 * @param userId the account whose password is being replaced
 * @param password the new password
 * @returns the state to render
 */
export async function setUserPassword(userId: string, password: string): Promise<ActionState> {
	return panelAction("users:set-password", () => setAccountPassword(userId, password), {
		revalidate,
		target: await accountTarget(userId),
		// No `detail` at all. There is nothing about this to record beyond that it happened, and the
		// only field available is the one that must never be stored.
	});
}

/**
 * Requires an account to replace its password before it can reach anything.
 *
 * @param userId the account to block
 * @returns the state to render
 */
export async function forcePasswordReset(userId: string): Promise<ActionState> {
	return panelAction("users:force-reset", () => requirePasswordChange(userId), {
		revalidate,
		target: await accountTarget(userId),
	});
}

/**
 * Bans an account.
 *
 * The expiry crosses the wire as an ISO string rather than a `Date`: a server action's arguments are
 * serialised, and taking the string here means one place parses it rather than trusting whatever
 * survived the trip.
 *
 * @param userId the account to ban
 * @param reason why, in the operator's own words
 * @param expiresAt when it lifts, as an ISO timestamp, or null for a ban that does not
 * @returns the state to render
 */
export async function banUser(userId: string, reason: string, expiresAt: string | null): Promise<ActionState> {
	return panelAction(
		"users:ban",
		(user) => {
			const until = expiresAt === null ? null : new Date(expiresAt);
			if (until !== null && Number.isNaN(until.getTime())) {
				throw new ApiError("invalid_type", "That is not a valid date.");
			}
			return banAccount(user, userId, reason, until);
		},
		{
			revalidate,
			target: await accountTarget(userId),
			detail: { reason, expiresAt },
		},
	);
}

/**
 * Lifts an account's ban.
 *
 * @param userId the account to unban
 * @returns the state to render
 */
export async function unbanUser(userId: string): Promise<ActionState> {
	return panelAction("users:unban", () => unbanAccount(userId), {
		revalidate,
		target: await accountTarget(userId),
	});
}

/**
 * Lists the sessions an account holds.
 *
 * A `query` rather than a `command`: it is opened by a dialog and changes nothing, so a row per
 * viewing would bury the revocations it sits beside. A refusal is still recorded, which is the
 * property that matters — see the registry's own note on `kind`.
 *
 * @param userId the account to list
 * @returns its sessions, most recently active first, or an empty list when refused
 */
export async function listSessions(userId: string): Promise<UserSession[]> {
	return panelQuery<UserSession[]>(
		"users:list-sessions",
		async () => {
			const sessions = await listAccountSessions(userId);
			return sessions.map((session) => ({
				id: session.id,
				ipAddress: session.ipAddress,
				userAgent: session.userAgent,
				createdAt: session.createdAt.toISOString(),
				updatedAt: session.updatedAt.toISOString(),
				expiresAt: session.expiresAt.toISOString(),
			}));
		},
		{
			refused: () => [],
			failed: () => [],
			target: { kind: "user", id: userId },
		},
	);
}

/**
 * Ends one of an account's sessions.
 *
 * @param userId the account it belongs to, for the record
 * @param sessionId the session to end
 * @returns the state to render
 */
export async function revokeUserSession(userId: string, sessionId: string): Promise<ActionState> {
	return panelAction("users:revoke-session", () => revokeAccountSession(sessionId), {
		revalidate,
		target: await accountTarget(userId),
		detail: { sessionId },
	});
}

/**
 * Ends every session an account holds.
 *
 * @param userId the account to sign out everywhere
 * @returns the state to render
 */
export async function revokeUserSessions(userId: string): Promise<ActionState> {
	return panelAction("users:revoke-sessions", () => revokeAccountSessions(userId), {
		revalidate,
		target: await accountTarget(userId),
	});
}

/**
 * Deletes an account.
 *
 * @param userId the account to delete
 * @returns the state to render
 */
export async function deleteUser(userId: string): Promise<ActionState> {
	return panelAction("users:delete", (user) => deleteAccount(user, userId), {
		revalidate,
		// Read before the account is gone, which is the whole reason `accountTarget` exists: the row
		// has to name what was deleted, and afterwards there is nothing left to look up.
		target: await accountTarget(userId),
	});
}

/**
 * Replaces which roles an account holds.
 *
 * @param userId the account to change
 * @param roleIds the complete new set
 * @returns the state to render
 */
export async function setUserRoles(userId: string, roleIds: string[]): Promise<ActionState> {
	return panelAction("users:set-roles", (user) => setAccountRoles(user, userId, roleIds), {
		revalidate,
		target: await accountTarget(userId),
		detail: { roles: roleIds.length },
	});
}

/**
 * Replaces an account's individual permissions.
 *
 * @param userId the account to change
 * @param permissions the complete new set
 * @returns the state to render
 */
export async function setUserPermissions(userId: string, permissions: string[]): Promise<ActionState> {
	return panelAction("users:set-permissions", (user) => setAccountPermissions(user, userId, permissions), {
		revalidate,
		target: await accountTarget(userId),
		// Named in full rather than counted: which capabilities an account gained is the question,
		// and a number cannot answer it.
		detail: { permissions },
	});
}

/**
 * Clears another account's two-factor enrolment.
 *
 * @param userId the account to clear
 * @returns the state to render
 */
export async function disableTwoFactor(userId: string): Promise<ActionState> {
	return panelAction("users:disable-2fa", () => clearTwoFactor(userId), {
		revalidate,
		target: await accountTarget(userId),
	});
}

/**
 * Promotes an account to superuser, or demotes one.
 *
 * Not special-cased in this file, and it does not need to be: `users:set-superuser` is never
 * grantable, so the gate in front of this action already answers true only for a superuser.
 *
 * @param userId the account to promote or demote
 * @param isSuperuser what it should become
 * @returns the state to render
 */
export async function setSuperuser(userId: string, isSuperuser: boolean): Promise<ActionState> {
	return panelAction("users:set-superuser", (user) => setAccountSuperuser(user, userId, isSuperuser), {
		revalidate: () => {
			revalidatePath("/users");
			// The sidebar's contents depend on what the account holds, and a promotion changes that
			// for whoever is promoted the moment they next render a page.
			revalidatePath("/", "layout");
		},
		target: await accountTarget(userId),
		detail: { isSuperuser },
	});
}
