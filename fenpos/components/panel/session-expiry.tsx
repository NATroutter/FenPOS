"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Sends the operator to sign-in the moment their session expires.
 *
 * The server-side guards are what make expiry *enforced* — the layout on every navigation, and
 * `requireSession` on every action. They are not enough on their own: a panel left open on a wall
 * display makes no requests, so nothing notices, and the screen goes on showing agents and printers
 * long after the session behind it is gone. The operator finds out by clicking something.
 *
 * The session's expiry is a time the server already knows, so the browser can simply wait for it.
 * A timer rather than polling, because the answer is not in doubt — there is nothing to ask.
 *
 * The clock is the browser's, which may be wrong or may have been asleep. That only affects *when*
 * this fires, never whether access is granted: it navigates to sign-in, and sign-in sends anyone
 * with a session that is still valid straight back to the panel. Firing early costs a redirect;
 * firing late is covered by the server-side guards.
 *
 * @param expiresAt when the current session stops being valid, as epoch milliseconds
 */
export function SessionExpiry({ expiresAt }: { expiresAt: number }) {
	const router = useRouter();

	useEffect(() => {
		const remaining = expiresAt - Date.now();

		if (remaining <= 0) {
			router.replace("/login");
			return;
		}

		const timer = setTimeout(() => router.replace("/login"), remaining);
		return () => clearTimeout(timer);
	}, [expiresAt, router]);

	return null;
}
