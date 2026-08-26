import { currentUser, sessionVerdict } from "@/lib/auth/require-session";
import { type PanelEvent, subscribe } from "@/lib/events/bus";
import { logger } from "@/lib/logger";
import { integerSetting } from "@/lib/settings/settings-service";

/**
 * `GET /api/events` — the panel's live stream.
 *
 * Server-sent events rather than a WebSocket. The traffic is one-directional and low volume, SSE
 * reconnects on its own without any code here, and it rides on the same HTTP connection handling
 * every other request — where a second WebSocket would have to be routed past Next's own upgrade
 * handling, which this process already does once and would rather not do twice.
 *
 * **Every gate the panel applies, and not one of them by hand.** The stream carries job identifiers,
 * device names and log lines from every site in the install, which is more than any API key is ever
 * granted — so a session that may not open a panel page may not open this either.
 *
 * Gated with {@link currentUser} plus {@link sessionVerdict} rather than with `requireSession`: the
 * latter redirects an unauthenticated caller, and a redirect is wrong here — the browser's
 * `EventSource` would follow it and receive an HTML redirect target on a connection it opened
 * expecting `text/event-stream`. `sessionVerdict` is the same set of gates without the redirecting,
 * which is what stops this route drifting behind them: it used to repeat only the
 * `mustChangePassword` check, and by the time the inactivity timeout and the two-factor enrolment
 * gate had been added, an account with no authenticator — refused everywhere else on an install with
 * `auth.require2fa` on — could still open the stream with nothing but a password.
 *
 * A refusal here ends the connection rather than the session, unlike `requireSession`, which signs
 * an idled-out or newly-disallowed caller out on its way to `/login`. Writing a cookie onto a stream
 * the browser will immediately reconnect to buys nothing; the operator's next navigation goes
 * through `requireSession` and is ended there.
 *
 * **Checked once, at connection.** A stream opened by a session that later idles out or is revoked
 * stays open until the client reconnects, which `EventSource` does on its own whenever the
 * connection drops. That is a known bound on how quickly a gate reaches an already-open stream.
 *
 * **And a connection here is not evidence anybody is at the keyboard**, which is why the gate runs
 * with `countsAsActivity: false`. Those same reconnects are the browser's doing — nothing on this
 * side asks for them, and the keepalive below exists precisely because proxies drop this connection.
 * Left counting as activity, they would refresh `lastSeenAt` on their own: an unattended terminal on
 * a lossy network would never reach its inactivity timeout, and an abandoned tab would look like the
 * account's most recently used session and survive the concurrency cap at the expense of the one its
 * operator is actually working in. The gate still *reads* the stamp — a session already past the
 * timeout is refused here exactly as it is anywhere else — it just does not move it.
 */

/** Never cached and never prerendered: the whole point is that it does not end. */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
	const user = await currentUser();
	// One message for every refusal, the way the sign-in form has one: which gate stopped a caller is
	// not something a connection this route is about to close needs to be told.
	if (!user || (await sessionVerdict(user, { countsAsActivity: false })) !== "allowed") {
		return Response.json({ error: "missing_key", message: "Not signed in." }, { status: 401 });
	}

	// Proxies and load balancers close a connection that has been silent for a while, and the
	// browser would reconnect every time — a reconnect storm on an install that is simply quiet.
	// A comment line costs nothing and is ignored by the client. Read once per opened stream,
	// not per line written to it, so a saved change reaches only streams opened after it.
	const keepaliveMs = (await integerSetting("events.keepaliveSeconds")) * 1000;

	const encoder = new TextEncoder();

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			let open = true;

			const write = (chunk: string): void => {
				if (!open) {
					return;
				}
				try {
					controller.enqueue(encoder.encode(chunk));
				} catch {
					// The client went away between the check and the write. Ordinary; the abort
					// handler below performs the cleanup.
					open = false;
				}
			};

			const unsubscribe = subscribe((event: PanelEvent) => {
				// Named by kind so the client can attach one handler per concern rather than
				// switching over a payload field.
				write(`event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`);
			});

			const keepalive = setInterval(() => write(": keepalive\n\n"), keepaliveMs);

			const close = (): void => {
				if (!open) {
					return;
				}
				open = false;
				clearInterval(keepalive);
				unsubscribe();
				try {
					controller.close();
				} catch {
					// Already closed by the runtime when the client disconnected.
				}
			};

			request.signal.addEventListener("abort", close);

			// Sent immediately so the browser's EventSource fires `open` rather than sitting in
			// CONNECTING until the first real event, which on a quiet install could be hours.
			write(": connected\n\n");
			logger.info("Panel event stream opened");
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
			// Tells nginx not to buffer, which would otherwise hold every event until the
			// response ended — and it never does.
			"X-Accel-Buffering": "no",
		},
	});
}
