"use server";

import { redirect } from "next/navigation";
import { recordAudit, userActor } from "@/lib/audit/audit-log";
import { AUTH_AUDIT_ACTIONS } from "@/lib/audit/auth-events";
import { requestProvenance } from "@/lib/audit/provenance";
import { auth } from "@/lib/auth/auth";
import { authHeaders } from "@/lib/auth/auth-headers";

/**
 * Revokes the current session and returns to sign-in.
 *
 * Better Auth deletes the session row as part of `signOut`, so the token cannot be replayed by
 * anyone who captured it.
 *
 * **Shared rather than owned by the panel layout**, which is where it used to live. The two gate
 * pages — `/set-password` and `/enrol-2fa` — sit outside that layout on purpose, so they had a
 * session and no way to end it: an operator who reached one of them on the wrong account, or who
 * simply could not finish, had nothing on screen but the thing they could not do. A second copy of
 * this would be a second idea of whether signing out is worth an audit row.
 */
export async function signOut(): Promise<void> {
	const requestHeaders = await authHeaders();
	// Read before the session is destroyed: afterwards there is no id to record and no user to
	// attribute the row to.
	const session = await auth.api.getSession({ headers: requestHeaders });

	await auth.api.signOut({ headers: requestHeaders });

	if (session?.user) {
		await recordAudit({
			action: AUTH_AUDIT_ACTIONS.SIGN_OUT,
			outcome: "SUCCESS",
			actor: userActor(session.user),
			provenance: await requestProvenance(session.session.id),
		});
	}

	redirect("/login");
}
