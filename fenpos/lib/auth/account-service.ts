import "server-only";
import { z } from "zod";
import { assertNotLastSuperuser, assertNotSelf } from "@/lib/auth/account-guards";
import { credentialAccountRow } from "@/lib/auth/credential-account";
import { assertMayAssignRoles, assertMayGrant, type Granter, parseGrantedPermissions } from "@/lib/auth/grant-guard";
import { hashPassword, passwordSchema } from "@/lib/auth/password";
import { MAXIMUM_DISPLAY_NAME_LENGTH } from "@/lib/auth/password-policy";
import { prisma } from "@/lib/db";
import { isUniqueViolationOn } from "@/lib/db-errors";
import { type PanelPermission, parseStoredPanelPermissions } from "@/lib/domain/panel-permissions";
import { ApiError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { integerSetting } from "@/lib/settings/settings-service";

/**
 * Creating, changing and removing panel accounts.
 *
 * Rows are written directly rather than through Better Auth's admin endpoints, following
 * `lib/auth/setup.ts`, which does the same and argues the case. The short version: `isSuperuser`
 * and `mustChangePassword` are declared `input: false` so no request body can set them, which also
 * puts them out of the library's own create path's reach — and an account that exists before its
 * forced-reset flag does is an account that can sign in without one. Everything that has to be true
 * at once is therefore written in one transaction.
 *
 * **Nothing here checks a permission.** The registry's gate has already done that by the time an
 * action calls in. What is checked here is what a permission does not settle: that a granter is not
 * handing out more than they hold, that nobody removes the last superuser, and that nobody bans or
 * deletes themselves.
 */

/** An account as the Users page displays it. */
export interface AccountSummary {
	id: string;
	name: string;
	email: string;
	isSuperuser: boolean;
	/** True while the account owes a password change and can reach nothing but the page that takes it. */
	mustChangePassword: boolean;
	banned: boolean;
	banReason: string | null;
	/** When the ban lifts on its own, or null for one that does not. */
	banExpires: Date | null;
	twoFactorEnabled: boolean;
	createdAt: Date;
	/** Roles this account belongs to, by id and name. */
	roles: { id: string; name: string }[];
	/** Permissions granted to it directly, not counting anything its roles carry. */
	permissions: PanelPermission[];
	/** How many sessions it currently holds. */
	sessionCount: number;
}

/** Everything the creation form collects. */
export interface NewAccountInput {
	name: string;
	email: string;
	password: string;
	/** The "Require password reset" checkbox. */
	requirePasswordReset: boolean;
	roleIds: string[];
	permissions: string[];
}

/**
 * Lists every account for the Users page.
 *
 * Individual grants only. What a role carries is shown against the role, and unioning the two here
 * would make an account's own row unable to say which grants are its own — which is exactly the
 * question the page exists to answer.
 *
 * @returns accounts ordered by creation, oldest first, so the install's first superuser is first
 */
export async function listAccounts(): Promise<AccountSummary[]> {
	const rows = await prisma.user.findMany({
		orderBy: { createdAt: "asc" },
		include: {
			roles: { select: { role: { select: { id: true, name: true } } } },
			permissions: { select: { permission: true } },
			_count: { select: { sessions: true } },
		},
	});

	return rows.map((row) => ({
		id: row.id,
		name: row.name,
		email: row.email,
		// Read through Boolean rather than trusted as typed: SQLite stores these as integers and the
		// column is nullable, and a null must read as "no" — never as "unknown" and certainly never
		// as "yes". The same reasoning `require-session.ts` states.
		isSuperuser: Boolean(row.isSuperuser),
		mustChangePassword: Boolean(row.mustChangePassword),
		banned: Boolean(row.banned),
		banReason: row.banReason,
		banExpires: row.banExpires,
		twoFactorEnabled: Boolean(row.twoFactorEnabled),
		createdAt: row.createdAt,
		roles: row.roles.map((entry) => entry.role),
		permissions: parseStoredPanelPermissions(row.permissions.map((entry) => entry.permission)),
		sessionCount: row._count.sessions,
	}));
}

/**
 * Creates an account.
 *
 * Nothing is emailed, here or anywhere: whoever creates the account delivers the credentials
 * themselves. That is why the password is collected rather than generated, and why the "require a
 * reset" tick exists — it is the one thing that stops a password typed into a chat window staying
 * the account's password.
 *
 * @param actor the account creating it, whose own authority bounds what may be granted
 * @param input the form's contents
 * @returns the new account's id
 * @throws ApiError when a field is unacceptable, the address is taken, or a grant exceeds the
 *   actor's own authority
 */
export async function createAccount(actor: Granter, input: NewAccountInput): Promise<{ userId: string }> {
	const name = parseDisplayName(input.name);
	const email = parseEmail(input.email);
	const permissions = parseGrantedPermissions(input.permissions);
	const roleIds = [...new Set(input.roleIds)];

	const minimumPasswordLength = await integerSetting("auth.minimumPasswordLength");
	const parsedPassword = passwordSchema(minimumPasswordLength).safeParse(input.password);
	if (!parsedPassword.success) {
		throw new ApiError("invalid_type", parsedPassword.error.issues[0]?.message ?? "That password is not acceptable.");
	}

	// Both before anything is written, so a refused grant leaves no half-made account behind.
	await assertMayGrant(actor, permissions);
	await assertMayAssignRoles(actor, roleIds);

	// Hashed outside the transaction. Argon2id at the configured memory cost takes long enough that
	// holding SQLite's write lock across it would serialise every other writer behind a deliberately
	// slow computation, for no benefit — the same reasoning `completeSetup` states.
	const passwordHash = await hashPassword(parsedPassword.data);

	const userId = await prisma
		.$transaction(async (tx) => {
			const now = new Date();
			const user = await tx.user.create({
				data: {
					id: crypto.randomUUID(),
					name,
					email,
					// Nothing sends mail, so there is no verification loop to run and an address left
					// unverified forever would be a flag that never changes and never means anything.
					emailVerified: true,
					// Better Auth's own role string, which only its admin plugin reads. Set to the
					// plugin's own default so the two never disagree about a value neither of them
					// decides anything with. FenPOS authorisation reads `isSuperuser`.
					role: "user",
					// Not from the input, and there is no parameter for it. A new account is never a
					// superuser: promotion is `setAccountSuperuser`, which only a superuser reaches.
					isSuperuser: false,
					mustChangePassword: input.requirePasswordReset,
					createdAt: now,
					updatedAt: now,
				},
				select: { id: true },
			});

			await tx.account.create({ data: credentialAccountRow(user.id, passwordHash, now) });

			if (permissions.length > 0) {
				await tx.userPermission.createMany({
					data: permissions.map((permission) => ({ userId: user.id, permission })),
				});
			}
			if (roleIds.length > 0) {
				await tx.userRole.createMany({ data: roleIds.map((roleId) => ({ userId: user.id, roleId })) });
			}

			return user.id;
		})
		.catch((error: unknown) => {
			// The address was free when the form rendered and may not be now. Without this the caller
			// gets the gate's generic "check the server log" instead of the one thing they can act on.
			if (isUniqueViolationOn(error, ["email"])) {
				throw new ApiError("name_taken", "That email address is already in use.");
			}
			throw error;
		});

	logger.info("Account created", { userId, roles: roleIds.length, permissions: permissions.length });
	return { userId };
}

/**
 * Replaces an account's display name and email.
 *
 * The same two fields `updateProfile` lets an account change about itself, from the other side. No
 * password is asked for, for the same reason it is not there: neither field is a credential.
 *
 * @param userId the account to change
 * @param displayName the new name
 * @param email the new address
 * @throws ApiError when a field is unacceptable, or the address belongs to another account
 */
export async function updateAccount(userId: string, displayName: string, email: string): Promise<void> {
	const name = parseDisplayName(displayName);
	const address = parseEmail(email);

	try {
		await prisma.user.update({ where: { id: userId }, data: { name, email: address } });
	} catch (error) {
		if (isUniqueViolationOn(error, ["email"])) {
			throw new ApiError("name_taken", "That email address is already in use.");
		}
		throw error;
	}
}

/**
 * Deletes an account.
 *
 * Its sessions, credential, roles and grants go with it — every one of those relations cascades,
 * because a grant is a statement about an account that exists. **Its audit trail does not**, and
 * that is the deliberate opposite: `AuditEvent` stores the actor as plain columns rather than a
 * relation, so the record of what this account did survives the account. See `AuditEvent`'s own note
 * in the schema.
 *
 * @param actor the account doing the deleting
 * @param userId the account to delete
 * @throws ApiError when the target is the actor, or the last superuser
 */
export async function deleteAccount(actor: Granter, userId: string): Promise<void> {
	assertNotSelf(actor.id, userId, "delete");
	await assertNotLastSuperuser(userId, "deleted");

	await prisma.user.delete({ where: { id: userId } });
	logger.info("Account deleted", { userId });
}

/**
 * Promotes an account to superuser, or demotes one.
 *
 * The gate has already established that the caller is a superuser: `users:set-superuser` is in
 * `NEVER_GRANTABLE`, so no row confers it and `userHolds` answers true for a superuser and false for
 * everybody else. There is nothing extra to check here about the caller, only about the target.
 *
 * Better Auth's own `role` string is written alongside, so an install where the admin plugin's
 * endpoints are ever reached does not disagree with FenPOS about who is an administrator.
 *
 * @param actor the superuser making the change
 * @param userId the account to promote or demote
 * @param isSuperuser what it should become
 * @throws ApiError when demoting the actor themselves, or the last superuser
 */
export async function setAccountSuperuser(actor: Granter, userId: string, isSuperuser: boolean): Promise<void> {
	if (!isSuperuser) {
		assertNotSelf(actor.id, userId, "demote");
		await assertNotLastSuperuser(userId, "demoted");
	}

	await prisma.user.update({
		where: { id: userId },
		data: { isSuperuser, role: isSuperuser ? "admin" : "user" },
	});
	logger.info("Superuser status changed", { userId, isSuperuser });
}

/**
 * Validates a display name.
 *
 * @param raw the name as typed
 * @returns the trimmed name
 * @throws ApiError when it is empty or too long
 */
function parseDisplayName(raw: string): string {
	const name = (raw ?? "").trim();
	if (name === "") {
		throw new ApiError("missing_field", "A display name is required.");
	}
	if (name.length > MAXIMUM_DISPLAY_NAME_LENGTH) {
		throw new ApiError("invalid_type", `Keep the display name to ${MAXIMUM_DISPLAY_NAME_LENGTH} characters or fewer.`);
	}
	return name;
}

/**
 * Validates and normalises an email address.
 *
 * Lower-cased, because sign-in lower-cases what is typed before looking it up: two accounts
 * differing only by case would mean one of them could never sign in, and the column's unique
 * constraint would not stop them existing.
 *
 * @param raw the address as typed
 * @returns the normalised address
 * @throws ApiError when it is empty or not an address
 */
function parseEmail(raw: string): string {
	const address = (raw ?? "").trim().toLowerCase();
	if (address === "") {
		throw new ApiError("missing_field", "An email address is required.");
	}
	if (!z.email().safeParse(address).success) {
		throw new ApiError("invalid_type", "That is not a valid email address.");
	}
	return address;
}
