import type { PanelUser } from "@/lib/auth/require-session";

/**
 * A complete {@link PanelUser}, for tests that stub `requireSession`/`currentUser` outright rather
 * than resolve one for real.
 *
 * Three test files each hand-rolled this same shape as a local `SESSION_USER` constant, and one of
 * them — `test/app/(panel)/settings/actions.test.ts`, before this existed — left out `sessionId` and
 * `twoFactorEnabled`. That was silent rather than a type error: a `vi.mock` factory's return value
 * is not checked against the module it replaces, so a caller could pass an incomplete object and only
 * notice if a test happened to assert on the missing fields. Nothing did — `panel-action.ts`'s
 * `record()` calls `requestProvenance(user.sessionId)` on every gated action, so a fixture missing
 * `sessionId` silently exercised `requestProvenance(undefined)` (which defaults to `null`) instead of
 * a real session id, and no assertion in that file noticed. Building it here, against the real type,
 * makes that omission a compile error instead.
 *
 * @param overrides fields to replace on the default account
 * @returns a `PanelUser`
 */
export function panelUser(overrides: Partial<PanelUser> = {}): PanelUser {
	return {
		id: "test-user",
		name: "Test User",
		email: "test@example.com",
		isSuperuser: true,
		mustChangePassword: false,
		sessionId: "session-test-user",
		twoFactorEnabled: false,
		...overrides,
	};
}
