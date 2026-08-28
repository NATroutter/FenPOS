import "server-only";
import { recordAudit, userActor } from "@/lib/audit/audit-log";
import { requestProvenance } from "@/lib/audit/provenance";
import { userHolds } from "@/lib/auth/effective-permissions";
import { type PanelActionId, panelActionEntry } from "@/lib/auth/panel-actions";
import { REFUSAL_MESSAGE } from "@/lib/auth/require-permission";
import { currentSessionId, type PanelUser, requireSession } from "@/lib/auth/require-session";
import { ApiError } from "@/lib/errors";
import type { ActionState } from "@/lib/panel/action-state";

/**
 * The one place that decides whether a panel action may proceed.
 *
 * In order: resolve the session, check the registry's permission, run the body, write the audit
 * row. Three properties fall out of there being exactly one such place — a denied action is
 * recorded before it returns, so permission probing is visible; a thrown action is recorded as a
 * failure, so an attempt that did not work is as much a part of the record as one that did; and a
 * superuser bypasses the check while being audited identically, because a superuser's actions are
 * the ones most worth having in the record.
 *
 * Two entry points rather than one, because eleven of the panel's actions shape their own result:
 * a key mint returns its one-time secret, a preview returns rendered text. {@link panelAction} is
 * for the ones that return {@link ActionState}; {@link panelQuery} is for the rest. Which wrapper
 * an action uses is a fact about its return type and says nothing about what gets audited — that
 * is the registry entry's `kind`.
 *
 * **The session's absence throws and a refusal does not.** `requireSession` signals by redirecting,
 * which is a throw that must reach Next; a refusal becomes a value the form renders. Keeping those
 * two apart is why the gate returns a result instead of raising.
 */

/** What an action can tell the record beyond its own id. */
export interface PanelActionOptions {
	/** What to refresh on success. Omitted when the action changes nothing a page renders. */
	revalidate?: () => void;
	/** What was acted on. Denormalised into the row, so it survives the thing's deletion. */
	target?: { kind: string; id?: string | null; label?: string | null };
	/** Extra named fields for the row. Never a raw `FormData` dump — see `recordAudit`. */
	detail?: Record<string, unknown>;
}

/** What the gate decided. */
type GateResult = { allowed: true; user: PanelUser } | { allowed: false; user: PanelUser; permission: string };

/**
 * The two actions that are how enrolling a second factor happens.
 *
 * `/enrol-2fa` renders `TwoFactorPanel` for an account that has none, on an install that requires
 * one — precisely the condition `requireSession`'s own enrolment gate redirects on. Gating these
 * two the ordinary way would make that redirect fire on their very first call, so `startTwoFactor`
 * would hand the page a redirect instead of a QR. `requireSession`'s `skipEnrolmentGate` exists for
 * exactly this set, and only for it — every other gate it runs still applies.
 *
 * `self:end-2fa` (turning a second factor *off*) is deliberately not here. Reaching it means
 * `user.twoFactorEnabled` is already true, at which point `!user.twoFactorEnabled` is false and the
 * enrolment gate was never going to fire regardless of this flag — `/enrol-2fa` never renders the
 * "turn it off" form in the first place (`enabled={false}` always), so there is no path that needs
 * the bypass for it. Widening this set to include it would only be a privilege change with no
 * matching need.
 */
const ENROLMENT_ACTION_IDS: ReadonlySet<PanelActionId> = new Set(["self:begin-2fa", "self:confirm-2fa"]);

/**
 * Resolves the session and checks the registry's permission.
 *
 * Must be called outside any `try` that catches broadly: `requireSession` redirects by throwing.
 *
 * @param id the action's registry id
 * @returns who is calling, and whether they may
 */
async function gate(id: PanelActionId): Promise<GateResult> {
	const entry = panelActionEntry(id);
	const user = await requireSession({ skipEnrolmentGate: ENROLMENT_ACTION_IDS.has(id) });

	if (entry.kind !== "command" && entry.kind !== "query") {
		// `custom`, `self` and `unauthenticated` carry no permission by construction, and the
		// registry's own test holds them to it.
		return { allowed: true, user };
	}

	if (entry.permission === null) {
		// Unreachable while `panel-actions.test.ts` passes. Treated as a refusal rather than as a
		// pass, because the one safe answer to "the rule is missing" is no.
		return { allowed: false, user, permission: id };
	}

	return (await userHolds(user, entry.permission))
		? { allowed: true, user }
		: { allowed: false, user, permission: entry.permission };
}

/**
 * Writes one row for an attempt.
 *
 * The session id in the row's provenance is read fresh via {@link currentSessionId} rather than
 * taken from `user.sessionId` as resolved before the body ran. Most actions never rotate their own
 * session, so this reads back exactly what `user.sessionId` already held — but three of them do:
 * `changePassword`'s `revokeOtherSessions: true`, and `verifyTOTP`/`disableTwoFactor` behind
 * `self:confirm-2fa` and `self:end-2fa`. For those, `user.sessionId` names a row the body's own work
 * has since deleted, and a record naming it would send an investigator looking for a session that no
 * longer exists. This is a `record()`-level fix rather than three per-action ones because the defect
 * is a property of *anything* that rotates its own session inside a gated action, not of these three
 * in particular — the next action to do that would otherwise reintroduce it.
 *
 * @param id the action's registry id
 * @param user who was acting
 * @param outcome how it went
 * @param options the caller's target and detail
 * @param detail extra fields merged over the caller's
 */
async function record(
	id: PanelActionId,
	user: PanelUser,
	outcome: "SUCCESS" | "DENIED" | "FAILURE",
	options: PanelActionOptions,
	detail: Record<string, unknown> = {},
): Promise<void> {
	await recordAudit({
		action: id,
		outcome,
		actor: userActor(user),
		target: options.target,
		detail: { ...options.detail, ...detail },
		provenance: await requestProvenance(await currentSessionId(user.sessionId)),
	});
}

/**
 * The message shown for an unexpected failure.
 *
 * One sentence for every one of them: an internal message in a toast is at best noise and at worst
 * a disclosure. The record keeps what actually happened.
 */
const FAILURE_MESSAGE = "Something went wrong. Check the server log.";

/**
 * Runs an action that reports back as {@link ActionState}.
 *
 * An `ApiError` carries a message written to be read, so it is passed through. Anything else is
 * unexpected and reported generically — the behaviour every per-file `run()` helper already had,
 * kept, with the audit row added.
 *
 * @param id the action's registry id
 * @param work the action body, given the acting user
 * @param options what to revalidate, and what to name in the record
 * @returns the state to render
 */
export async function panelAction(
	id: PanelActionId,
	work: (user: PanelUser) => Promise<void>,
	options: PanelActionOptions = {},
): Promise<ActionState> {
	// Outside the try: an absent session redirects, and `redirect` signals by throwing.
	const gated = await gate(id);

	if (!gated.allowed) {
		await record(id, gated.user, "DENIED", options, { permission: gated.permission });
		return { error: REFUSAL_MESSAGE };
	}

	try {
		await work(gated.user);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await record(id, gated.user, "FAILURE", options, { error: message });
		return { error: error instanceof ApiError ? error.message : FAILURE_MESSAGE };
	}

	// After the body, never before: a page refreshed to show a change that did not happen is worse
	// than one that is briefly stale.
	options.revalidate?.();
	await record(id, gated.user, "SUCCESS", options);
	return { error: null };
}

/**
 * Runs an action that shapes its own result.
 *
 * The caller supplies what refusal and failure look like in its own shape, because there is no
 * general answer: a preview's refusal is text in a field, a listing's is an empty list, and a key
 * mint's is a null secret.
 *
 * Whether success is recorded is the registry's decision, not this function's. A `query` stays
 * quiet — `preview` runs as an operator types, and a row per keystroke would bury the rows worth
 * reading — while a `command` that merely returns its own shape, such as minting a key, is recorded
 * like any other.
 *
 * @param id the action's registry id
 * @param work the action body, given the acting user
 * @param options how to shape a refusal and a failure, plus the usual record fields
 * @returns the body's own result, or one of those two
 */
export async function panelQuery<T>(
	id: PanelActionId,
	work: (user: PanelUser) => Promise<T>,
	options: { refused: () => T; failed: (error: unknown) => T } & PanelActionOptions,
): Promise<T> {
	const gated = await gate(id);

	if (!gated.allowed) {
		await record(id, gated.user, "DENIED", options, { permission: gated.permission });
		return options.refused();
	}

	let result: T;
	try {
		result = await work(gated.user);
	} catch (error) {
		await record(id, gated.user, "FAILURE", options, {
			error: error instanceof Error ? error.message : String(error),
		});
		return options.failed(error);
	}

	options.revalidate?.();
	if (panelActionEntry(id).kind !== "query") {
		await record(id, gated.user, "SUCCESS", options);
	}
	return result;
}

/**
 * Resolves the session for an action that does its own checking.
 *
 * For the registry's `custom` and `self` kinds: `saveSettings`, which checks a permission per
 * staged change because its batch spans setting categories; the two `archives:*` reads, which are
 * governed by `logs:read` or `audit:read` according to which period the call names; and the actions
 * on the caller's own account, which are deliberately ungated. Those actions write their own rows,
 * because only they know what happened.
 *
 * **This resolves the session and nothing else.** It is not a gate with the check left out — a caller
 * reaching it has to perform its own, and the registry's `custom` kind is the written record that it
 * does. Registering an action `custom` to avoid writing a permission down would turn that record into
 * a hole shaped exactly like this function.
 *
 * @param id the action's registry id, so calling this on a gated action is a mistake the reader can
 *   see
 * @returns the signed-in user
 * @throws Error when the id names an action that should have gone through the gate
 */
export async function panelSelf(id: PanelActionId): Promise<PanelUser> {
	const entry = panelActionEntry(id);
	if (entry.kind !== "custom" && entry.kind !== "self") {
		throw new Error(`Panel action "${id}" is gated; call panelAction or panelQuery instead of panelSelf`);
	}
	return requireSession();
}
