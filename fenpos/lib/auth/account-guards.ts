import "server-only";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/errors";

/**
 * The two ways this install could be locked out of itself.
 *
 * There is no email loop, no password-reset link, and setup seals permanently, so an install with
 * no reachable superuser has exactly one way back: the recovery CLI, which needs filesystem access
 * to the server. Both guards below exist to keep that from being the ordinary consequence of a
 * misclick, and both live in the service rather than in the dialog that offers the button — a
 * dialog is not a boundary, and the action behind it is a POST endpoint anyone can call directly.
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
