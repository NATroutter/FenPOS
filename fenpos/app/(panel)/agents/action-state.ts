/**
 * Re-exported from `lib/panel/action-state.ts`, where the type now lives.
 *
 * Kept as a module of its own because a `"use server"` module may only export async functions —
 * every export becomes a callable server endpoint, so a plain object is rejected at module
 * evaluation. The failure surfaces as a 500 on first use rather than at build time, which is why
 * `actions.ts` still cannot hold this and why this file still exists rather than every tab being
 * repointed at the new path.
 */
export { type ActionState, IDLE } from "@/lib/panel/action-state";
