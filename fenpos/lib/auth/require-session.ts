import "server-only";
import { redirect } from "next/navigation";
import { getCurrentSession } from "@/lib/auth/session-cookie";

/**
 * Sends the caller to sign-in unless the request carries a valid administrator session.
 *
 * Every panel action calls this. The layout already guards the page, but an action is a POST
 * endpoint in its own right: anything that trusted the layout would be callable directly by
 * anyone who knew the action id. Authorisation belongs at the action, not at the page that
 * happens to render its button.
 *
 * **It redirects rather than returning an error.** Each tab used to keep its own copy of this
 * check, throwing an `ApiError` that the action's own catch turned into a toast — so a session
 * that expired while the panel sat open produced "Not signed in." over a screen still showing
 * agents, printers and keys, and an operator who dismissed it was left looking at a panel where
 * nothing worked and nothing said why. There is one thing to do when the session is gone, and
 * the panel should just do it.
 *
 * `redirect` signals by throwing, so this must be called **outside** any `try` that catches
 * broadly — a catch that swallowed it would reinstate the behaviour this exists to remove.
 */
export async function requireSession(): Promise<void> {
	if (!(await getCurrentSession())) {
		redirect("/login");
	}
}
