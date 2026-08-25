/**
 * The shape every panel action reports back to the form that invoked it.
 *
 * Lives under `lib/` rather than beside one tab's actions because every tab uses it and, since the
 * shared gate in `lib/auth/panel-action.ts` returns it, a library would otherwise have to import
 * from `app/` — a dependency pointing the wrong way. `app/(panel)/agents/action-state.ts` re-exports
 * these, so no call site had to change.
 */
export interface ActionState {
	/** Message to display when something went wrong, or null on success. */
	error: string | null;
}

/** Initial state for a form that has not been submitted. */
export const IDLE: ActionState = { error: null };
