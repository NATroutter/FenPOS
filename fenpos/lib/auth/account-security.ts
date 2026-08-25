import "server-only";
import { assertNotLastSuperuser, assertNotSelf } from "@/lib/auth/account-guards";
import { CREDENTIAL_ISSUER } from "@/lib/auth/credential-account";
import type { Granter } from "@/lib/auth/grant-guard";
import { hashPassword, passwordSchema } from "@/lib/auth/password";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { integerSetting } from "@/lib/settings/settings-service";

/**
 * Everything that ends or restrains an account's access.
 *
 * One module rather than a function apiece scattered through the lifecycle service, because this is
 * the set somebody reads together during an incident: what was done to this account, and did it take
 * effect immediately.
 *
 * **Immediacy is the point.** Sessions here are database rows, which is the property this whole
 * rebuild was chosen around — the alternative library's credentials provider steers callers to
 * self-contained JWTs, and a JWT cannot be revoked before it expires. So every function below that
 * should end access deletes session rows rather than trusting a flag to be noticed.
 *
 * **A ban does not end a session by itself.** `better-auth`'s admin plugin reads `banned` in exactly
 * one place — a `session.create.before` hook — so it refuses the next sign-in and leaves an open tab
 * working. {@link banAccount} deletes the rows in the same transaction that sets the flag. Do not
 * replace that with a check in `require-session`: `/login` bounces an authenticated visitor to
 * `/dashboard`, so sending a banned account that still holds a cookie to `/login` is a loop.
 */

/** One live session, as the Users page lists it. */
export interface SessionSummary {
	id: string;
	/** Where it was last seen from, as `lib/request-context.ts` derived it. Null for a row written without one. */
	ipAddress: string | null;
	userAgent: string | null;
	createdAt: Date;
	/** Last extended. The closest thing to "last seen" the session row carries. */
	updatedAt: Date;
	expiresAt: Date;
}

/**
 * Lists the sessions an account currently holds.
 *
 * @param userId the account to list
 * @returns its sessions, most recently active first
 */
export async function listAccountSessions(userId: string): Promise<SessionSummary[]> {
	return prisma.session.findMany({
		where: { userId },
		orderBy: { updatedAt: "desc" },
		select: { id: true, ipAddress: true, userAgent: true, createdAt: true, updatedAt: true, expiresAt: true },
	});
}

/**
 * Sets another account's password.
 *
 * The current password is not asked for, unlike `changePassword` on the caller's own account: an
 * administrator resetting somebody's password does not have it, which is the entire reason this
 * exists. Every session the account held is ended, because a password reset that left the old
 * session working would not be a reset.
 *
 * Written against the credential row directly, matching how the account was created. `updateMany`
 * rather than `update`, because the row is identified by a pair rather than by a key Prisma can
 * address — and its count is checked, so an account with no credential is reported rather than
 * silently left with the password it had.
 *
 * @param userId the account whose password is being replaced
 * @param password the new password
 * @throws ApiError when the password is unacceptable, or the account has no credential
 */
export async function setAccountPassword(userId: string, password: string): Promise<void> {
	const minimumPasswordLength = await integerSetting("auth.minimumPasswordLength");
	const parsed = passwordSchema(minimumPasswordLength).safeParse(password);
	if (!parsed.success) {
		throw new ApiError("invalid_type", parsed.error.issues[0]?.message ?? "That password is not acceptable.");
	}

	const passwordHash = await hashPassword(parsed.data);

	await prisma.$transaction(async (tx) => {
		const { count } = await tx.account.updateMany({
			where: { userId, issuer: CREDENTIAL_ISSUER },
			data: { password: passwordHash, updatedAt: new Date() },
		});
		if (count === 0) {
			throw new ApiError("invalid_type", "That account has no password to replace.");
		}
		await tx.session.deleteMany({ where: { userId } });
	});

	// Nothing about the password reaches the log or the record: not its length, not its strength.
	logger.info("Account password set by an administrator", { userId });
}

/**
 * Requires an account to replace its password before it can reach anything.
 *
 * Its sessions are ended along with the flag. Without that the operator carries on browsing on the
 * session they already hold, and the reset they are meant to be blocked by does not appear until
 * they happen to sign out — which is not what "force" means.
 *
 * @param userId the account to block
 */
export async function requirePasswordChange(userId: string): Promise<void> {
	await prisma.$transaction([
		prisma.user.update({ where: { id: userId }, data: { mustChangePassword: true } }),
		prisma.session.deleteMany({ where: { userId } }),
	]);
	logger.info("Password reset forced", { userId });
}

/**
 * Bans an account, with a reason and an optional expiry.
 *
 * A reason is required rather than optional: a ban is read months later by somebody deciding
 * whether to lift it, and a row that says only "banned" cannot be acted on. An expiry is optional
 * because "banned until Monday" and "banned" are both things an operator can mean — the library
 * lifts a lapsed ban itself, at the next sign-in attempt.
 *
 * @param actor the account applying the ban
 * @param userId the account being banned
 * @param reason why, in the operator's own words
 * @param expiresAt when it lifts on its own, or null for one that does not
 * @throws ApiError when the target is the actor, the last superuser, or the reason is empty
 */
export async function banAccount(
	actor: Granter,
	userId: string,
	reason: string,
	expiresAt: Date | null,
): Promise<void> {
	assertNotSelf(actor.id, userId, "ban");
	await assertNotLastSuperuser(userId, "banned");

	const banReason = (reason ?? "").trim();
	if (banReason === "") {
		throw new ApiError("missing_field", "A reason is required. A ban nobody can explain cannot be reviewed.");
	}

	await prisma.$transaction([
		prisma.user.update({ where: { id: userId }, data: { banned: true, banReason, banExpires: expiresAt } }),
		// The flag alone refuses the next sign-in and nothing else. This is what ends the session
		// already open. See the module comment.
		prisma.session.deleteMany({ where: { userId } }),
	]);

	logger.info("Account banned", { userId, expiresAt: expiresAt?.toISOString() ?? null });
}

/**
 * Lifts a ban.
 *
 * All three columns are cleared together. Leaving a stale reason or expiry behind would make a live
 * account look banned to anyone reading the row directly.
 *
 * @param userId the account to unban
 */
export async function unbanAccount(userId: string): Promise<void> {
	await prisma.user.update({
		where: { id: userId },
		data: { banned: false, banReason: null, banExpires: null },
	});
	logger.info("Ban lifted", { userId });
}

/**
 * Ends one session.
 *
 * `deleteMany` rather than `delete`: a session that expired or was signed out between the page
 * rendering and the button being pressed is not an error, it is the outcome the operator wanted.
 *
 * @param sessionId the session to end
 */
export async function revokeAccountSession(sessionId: string): Promise<void> {
	await prisma.session.deleteMany({ where: { id: sessionId } });
}

/**
 * Ends every session an account holds.
 *
 * @param userId the account to sign out everywhere
 */
export async function revokeAccountSessions(userId: string): Promise<void> {
	const { count } = await prisma.session.deleteMany({ where: { userId } });
	logger.info("Sessions revoked", { userId, count });
}

/**
 * Clears another account's two-factor enrolment.
 *
 * The rows and the flag go together. Leaving `twoFactorEnabled` set with no secret behind it would
 * present the account a challenge it has nothing to answer with, which is a lockout rather than a
 * reset — and clearing enrolment is what somebody who has lost their authenticator needs.
 *
 * Enrolling is phase 6's; this half is here because it is a thing done *to* another account and
 * belongs with the rest of them.
 *
 * @param userId the account to clear
 */
export async function clearTwoFactor(userId: string): Promise<void> {
	await prisma.$transaction([
		prisma.twoFactor.deleteMany({ where: { userId } }),
		prisma.user.update({ where: { id: userId }, data: { twoFactorEnabled: false } }),
	]);
	logger.info("Two-factor enrolment cleared", { userId });
}
