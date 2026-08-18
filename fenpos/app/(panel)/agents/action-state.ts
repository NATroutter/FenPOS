/**
 * The shape a Agents action reports back to the form that invoked it.
 *
 * Kept out of actions.ts because a `"use server"` module may only export async functions —
 * every export becomes a callable server endpoint, so a plain object is rejected at module
 * evaluation. The failure surfaces as a 500 on first use rather than at build time, which is
 * why this separation is worth keeping deliberate.
 */
export interface ActionState {
	/** Message to display when something went wrong, or null on success. */
	error: string | null;
}

/** Initial state for a form that has not been submitted. */
export const IDLE: ActionState = { error: null };
