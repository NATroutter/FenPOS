import "server-only";
import { NO_PROVENANCE, type RequestProvenance } from "@/lib/audit/provenance-shape";
import { getClientAddress, getUserAgent } from "@/lib/request-context";

export { NO_PROVENANCE, type RequestProvenance };

/**
 * Where a request came from, as the audit record wants it.
 *
 * A thin layer over `lib/request-context.ts` rather than a second derivation of the same headers:
 * how the client address is derived is a security decision that module already argues for at
 * length — the rightmost `X-Forwarded-For` hop, because the leftmost is whatever the client
 * claimed. An audit row that recorded a different address than the rate limiter keyed on would be
 * worse than one that recorded none.
 *
 * `RequestProvenance` and `NO_PROVENANCE` themselves live in `lib/audit/provenance-shape.ts` and are
 * re-exported above unchanged: they carry no dependency on `next/headers`, so a module that only
 * needs to name or default a provenance — `lib/audit/append.ts`, for the CLI's case — can import
 * that file directly and skip the `import "server-only"` below.
 */

/**
 * Reads this request's provenance.
 *
 * **Never throws**, which is the reason it exists rather than callers reaching for
 * `getClientAddress` directly. `next/headers` raises outside a request scope, and this is called
 * from the audit path — where a raise would turn a missing IP address into a failed action. A
 * caller with no request gets {@link NO_PROVENANCE} instead.
 *
 * `getClientAddress`'s `UNKNOWN_ADDRESS` sentinel is stored as it stands rather than normalised to
 * null. `Session.ipAddress` and the pairing records already hold that same string for a caller no
 * header identified, and a row saying null here would be the one place in the schema where "we
 * could not tell" is indistinguishable from "there was nothing to tell".
 *
 * @param sessionId the session this action was taken under, when the caller knows it
 * @returns the provenance, with nulls wherever there was no request to read
 */
export async function requestProvenance(sessionId: string | null = null): Promise<RequestProvenance> {
	try {
		return {
			ipAddress: await getClientAddress(),
			userAgent: await getUserAgent(),
			sessionId,
		};
	} catch {
		return { ...NO_PROVENANCE, sessionId };
	}
}
