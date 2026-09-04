/**
 * The audit action ids for events that have no session behind them.
 *
 * Signing in, signing out, replacing a password under a forced reset, and claiming an install are
 * all things that happen at the edge of authentication rather than inside it — there is no session
 * to check a permission against, which is why none of them is a panel action and why the panel
 * action registry does not absorb them.
 *
 * Declared as constants rather than written at the call sites because these strings are what a
 * later filter matches on, and a row that says `auth:signin` because somebody typed it that way
 * once is a row no filter finds.
 */
export const AUTH_AUDIT_ACTIONS = {
	/** Credentials presented at `/login`, however that turned out. */
	SIGN_IN: "auth:sign-in",
	/** A session ended deliberately from the panel. */
	SIGN_OUT: "auth:sign-out",
	/** A forced password change completed at `/set-password`. */
	SET_PASSWORD: "auth:set-password",
	/**
	 * A setup key refused.
	 *
	 * Only refusals. A key that checks out proves nothing, grants nothing and consumes nothing —
	 * the real check happens inside `completeSetup`'s transaction — so recording the successes
	 * would bury the refusals, which are the rows anyone would ever read this for.
	 */
	SETUP_KEY: "setup:key-check",
	/** An install claimed, or setup refused. */
	SETUP_COMPLETE: "setup:complete",
	/**
	 * A second factor presented at `/login`, however that turned out.
	 *
	 * Separate from `SIGN_IN` rather than folded into it. The two answer different questions — a run
	 * of failed sign-ins is somebody guessing a password, a run of failed challenges is somebody who
	 * already has one — and an investigation that could not tell them apart would miss the second.
	 */
	TWO_FACTOR: "auth:two-factor",
} as const;
