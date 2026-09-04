import "server-only";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/errors";

/**
 * The two ways this install could be locked out of itself, and the one way it could be taken over.
 *
 * There is no email loop, no password-reset link, and setup seals permanently, so an install with
 * no reachable superuser has exactly one way back: the recovery CLI, which needs filesystem access
 * to the server. The first two guards below exist to keep that from being the ordinary consequence
 * of a misclick, and both live in the service rather than in the dialog that offers the button — a
 * dialog is not a boundary, and the action behind it is a POST endpoint anyone can call directly.
 *
 * The third, {@link isProtectedSuperuserTarget}, answers the opposite question: not "does this
 * leave the install unadministered" but "does this hand the install to somebody who was not given
 * it". It is the only one of the three that the gate applies for itself.
 */

/**
 * Refuses an action aimed at the account performing it.
 *
 * Banning or deleting yourself is not an operation with a sensible outcome: it ends the session
 * carrying it out, and on the only superuser it ends the install's administration entirely.
 * Changing your own name, password or profile is a different matter and is deliberately ungated —
 * see the `self:*` entries in the action registry.
 *
 * @param actorId the account acting
 * @param targetUserId the account being acted on
 * @param verb what is being attempted, for the message: "ban", "delete", "demote"
 * @throws ApiError when they are the same account
 */
export function assertNotSelf(actorId: string, targetUserId: string, verb: string): void {
	if (actorId === targetUserId) {
		throw new ApiError("invalid_type", `You cannot ${verb} your own account.`);
	}
}

/**
 * Refuses an action that would leave the install with no superuser.
 *
 * Counted rather than inferred from a flag: "is there another one" is a question about the table,
 * and the only honest way to answer it is to look.
 *
 * @param targetUserId the account being acted on
 * @param participle what is being attempted, already in the past participle: "deleted", "banned",
 *   "demoted". Spelled out by the caller rather than derived from a verb, because deriving it gives
 *   "baned".
 * @throws ApiError when the account is unknown, or is the last superuser
 */
export async function assertNotLastSuperuser(targetUserId: string, participle: string): Promise<void> {
	const target = await prisma.user.findUnique({ where: { id: targetUserId }, select: { isSuperuser: true } });
	if (!target) {
		throw new ApiError("invalid_type", "That account no longer exists.");
	}
	if (!target.isSuperuser) {
		return;
	}

	if ((await prisma.user.count({ where: { isSuperuser: true } })) <= 1) {
		throw new ApiError(
			"invalid_type",
			`This is the last superuser and cannot be ${participle}. Promote another account first.`,
		);
	}
}

/**
 * Whether an account is off limits to the caller because it is a superuser and the caller is not.
 *
 * Authorization elsewhere in the panel is by action: holding `users:set-password` means the
 * password-setting action may run. That is the wrong shape for account management, because the
 * accounts are not interchangeable — replacing a superuser's password, or its email, or clearing
 * its second factor, is a way of *becoming* that superuser, and so hands the caller every
 * permission, including the ones the grant guard says can never be granted. A helpdesk permit is
 * not supposed to be a route to `users:set-superuser`.
 *
 * So the sensitivity of the *target* gets a say alongside the permission on the action. Applied by
 * `panel-action.ts`'s gate to every action carrying a user target, deliberately rather than by the
 * handful of action bodies that are exploitable today: an action added next month is then covered
 * without anyone having to remember that it needs to be.
 *
 * Superuser-on-superuser is allowed, which is how demotion happens, and is still floored by
 * {@link assertNotLastSuperuser}. So is acting on yourself, which is what keeps a superuser able to
 * change its own password through the Users tab. An unknown target is not protected, so a missing
 * account is reported by the action's own body — refusing here instead would answer "does this id
 * exist" on a different code path, and with different timing, than every other id.
 *
 * @param actor the account acting
 * @param targetUserId the account being acted on
 * @returns true when the call must be refused
 */
export async function isProtectedSuperuserTarget(
	actor: { id: string; isSuperuser: boolean },
	targetUserId: string,
): Promise<boolean> {
	if (actor.isSuperuser || actor.id === targetUserId) {
		return false;
	}
	const target = await prisma.user.findUnique({ where: { id: targetUserId }, select: { isSuperuser: true } });
	return target?.isSuperuser === true;
}
