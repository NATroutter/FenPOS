/**
 * The shape of request provenance, without the gate its resolver needs.
 *
 * Split out of `provenance.ts` so a module that only needs to *default* a missing provenance —
 * `lib/audit/append.ts`, for a caller like the CLI that has no request at all — does not have to
 * pull in `next/headers` to get it. `provenance.ts` needs `import "server-only"` for exactly one
 * reason: `requestProvenance` imports `@/lib/request-context`, which reaches `next/headers`. Neither
 * `RequestProvenance` nor `NO_PROVENANCE` has any such dependency, so they live here instead and
 * `provenance.ts` re-exports both — every existing import of them is unaffected.
 *
 * This is the same move `append.ts` itself made on `audit-log.ts`, for the same reason: a value that
 * two writers both need cannot be forked into two copies without becoming two opinions about it. Here
 * that value is hashed — `ipAddress`, `userAgent` and `sessionId` are three of the sixteen covered
 * fields in `lib/audit/chain.ts` — so a second, hand-kept `NO_PROVENANCE` would have been exactly the
 * kind of drift this module exists to rule out.
 */

/** Request details attached to an audit row. */
export interface RequestProvenance {
	ipAddress: string | null;
	userAgent: string | null;
	/**
	 * The session the row names as having taken the action, when the caller knows one.
	 *
	 * Not a guarantee that this is the session that *authenticated* the request — a caller whose own
	 * work rotates its session, such as `panel-action.ts`'s `record()` via `currentSessionId`, reads
	 * it fresh at write time instead, so the row names the session the request ended up on rather
	 * than the one it started with. A caller that never rotates its own session, which is every other
	 * one in this codebase, passes the id it resolved at the top of the request, and the two coincide.
	 */
	sessionId: string | null;
}

/** What a writer outside any request — the CLI, a startup task — records. */
export const NO_PROVENANCE: RequestProvenance = { ipAddress: null, userAgent: null, sessionId: null };
