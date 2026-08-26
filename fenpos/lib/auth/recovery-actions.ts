/**
 * The audit action ids `pnpm auth:recover` writes.
 *
 * Constants rather than strings at the call sites, for the reason `AUTH_AUDIT_ACTIONS` gives: these
 * are what a later filter matches on, and a row that says `recover:resetpassword` because somebody
 * typed it that way once is a row no filter finds.
 *
 * They are deliberately outside the panel action registry. That registry answers "may this session
 * do this", and the CLI has no session — it has filesystem access, which is a different authority
 * and a stronger one.
 */
export const RECOVERY_AUDIT_ACTIONS = {
	/** A password minted for an account that could not sign in. */
	RESET_PASSWORD: "recover:reset-password",
	/** An enrolment cleared for somebody who lost their authenticator and their codes. */
	CLEAR_TWO_FACTOR: "recover:clear-2fa",
	/** A lockout cleared before it expired on its own. */
	UNLOCK: "recover:unlock",
	/** The address allowlist emptied, because a wrong entry locks out everyone including its author. */
	CLEAR_ALLOWLIST: "recover:clear-allowlist",
} as const;
