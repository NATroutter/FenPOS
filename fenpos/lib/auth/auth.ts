import "server-only";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";
import { admin, twoFactor } from "better-auth/plugins";
import { hashPassword, MAXIMUM_PASSWORD_LENGTH, verifyPassword } from "@/lib/auth/password";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { globalSessionPolicy } from "@/lib/settings/settings-service";

/**
 * The panel's authentication instance.
 *
 * Better Auth replaces the hand-written credential layer this project carried until now. The
 * reason for a library at all is that credential code is the one part of a system where being
 * unattacked and being unattackable look identical from the inside, and this panel may end up
 * reachable from the public internet with physical printers behind it.
 *
 * The reason for *this* library rather than Auth.js is sessions. Auth.js's credentials provider
 * steers callers to self-contained JWTs, and a JWT cannot be revoked before it expires. Sessions
 * here stay database rows, so signing out, changing a password, or banning an account ends access
 * at once — the property the retired hand-written session layer was built around and the one
 * worth keeping.
 */

export const auth = betterAuth({
	database: prismaAdapter(prisma, { provider: "sqlite" }),
	secret: env.BETTER_AUTH_SECRET,
	// Undefined means "derive the origin from the request", which is right for a LAN install
	// reached by address. See the variable's own note in `lib/env.ts`.
	baseURL: env.BETTER_AUTH_URL,

	emailAndPassword: {
		enabled: true,
		/**
		 * No self-registration, ever.
		 *
		 * This is the single line that makes "accounts are created by an administrator" a fact
		 * rather than an intention: without it Better Auth serves a public sign-up endpoint at
		 * `/api/auth/sign-up/email` that would let anyone on the network mint themselves an
		 * account. First-run setup and the admin plugin's `createUser` both create users through
		 * the server-side API, which this flag does not gate.
		 */
		disableSignUp: true,
		/**
		 * argon2id, not Better Auth's default.
		 *
		 * The password is the one credential in this system chosen by a human and therefore the
		 * one with a brute-force surface worth paying for. `lib/auth/password.ts` holds the OWASP
		 * baseline parameters and the reasoning behind them; reusing it here also means a hash
		 * written by the recovery CLI and one written by the panel are the same kind of hash.
		 */
		password: {
			hash: (password) => hashPassword(password),
			verify: ({ hash, password }) => verifyPassword(hash, password),
		},
		/**
		 * Matched to `password.ts`'s own `MAXIMUM_PASSWORD_LENGTH` rather than left at Better
		 * Auth's default of 128.
		 *
		 * Setup hashes directly and enforces only `password.ts`'s bound, so a password between 129
		 * and 1024 characters is created and stored without Better Auth ever seeing it. Left
		 * unset, the first time that same password reached a Better Auth endpoint — signing in,
		 * or changing it from Settings — it would be refused as `PASSWORD_TOO_LONG` against a
		 * limit the operator was never told about and cannot see, and `settings/actions.ts`
		 * collapses that refusal into "That is not the current password," which is false. Setting
		 * this equal to `MAXIMUM_PASSWORD_LENGTH` closes the gap: every path that accepts a
		 * password agrees on the same ceiling.
		 */
		maxPasswordLength: MAXIMUM_PASSWORD_LENGTH,
	},

	user: {
		/**
		 * Every added field is `input: false`.
		 *
		 * That is what stops a crafted request body setting `isSuperuser` on a user it is
		 * otherwise allowed to create or update. These two fields are decided by the seal and by
		 * the account-management service, never by whatever arrived over the wire.
		 */
		additionalFields: {
			isSuperuser: { type: "boolean", input: false, defaultValue: false, returned: true },
			mustChangePassword: { type: "boolean", input: false, defaultValue: false, returned: true },
		},
	},

	session: {
		/**
		 * A floor, not the policy.
		 *
		 * Better Auth reads this once, when the instance is constructed at module load, so it cannot
		 * be the setting — `databaseHooks.session.create.before` below is where `auth.sessionHours`
		 * is actually applied. This value is what a session would get if that hook were ever
		 * bypassed, and it is deliberately the shortest sensible lifetime rather than the longest:
		 * the failure mode of a too-short session is signing in again, and of a too-long one is a
		 * session nobody intended.
		 */
		expiresIn: 60 * 60,
		// How often Better Auth extends an expiry. Left fixed: this governs the library's own
		// bookkeeping, while `auth.lastSeenRefreshMinutes` governs ours. See `session-policy.ts`.
		updateAge: 60 * 60,
		additionalFields: {
			lastSeenAt: { type: "date", required: false, input: false, returned: false },
		},
	},

	databaseHooks: {
		session: {
			create: {
				/**
				 * Where `auth.sessionHours` is actually applied.
				 *
				 * The `session.expiresIn` option above is evaluated once at module load, which is why
				 * the setting could not live there: it would either need a synchronous database read
				 * or would pin whatever value happened to be stored at the last restart. This hook
				 * runs per session creation and can await, so a change to the setting takes effect at
				 * the next sign-in rather than the next deploy.
				 *
				 * `lastSeenAt` is stamped here too, so every session created from now on has one and
				 * the null fallback in `session-policy.ts` covers only rows that predate the column.
				 *
				 * A read, never a write. The concurrency cap is a delete and is called from the
				 * sign-in path instead — see `enforceSessionCap` — because this hook may run inside
				 * Better Auth's own transaction and a delete there is how a SQLite deadlock is bought.
				 */
				async before(session) {
					const { sessionSeconds } = await globalSessionPolicy();
					const now = new Date();
					return {
						data: {
							...session,
							expiresAt: new Date(now.getTime() + sessionSeconds * 1000),
							lastSeenAt: now,
						},
					};
				},
			},
		},
	},

	plugins: [
		admin(),
		twoFactor(),
		// Must be last. It wraps the handlers that follow it to write `Set-Cookie` through
		// Next's cookie store, so anything registered after it would not get that treatment.
		nextCookies(),
	],
});
