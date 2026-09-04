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

/**
 * How many unread bytes one stream may hold before it starts dropping events.
 *
 * Every job update, log line, agent and device event in the whole install is fanned out to every
 * open stream. A client that stops reading — a wedged proxy, a suspended laptop, a script that opens
 * the connection and never consumes it — does not slow that fan-out down; it accumulates it, one
 * queued chunk per event, for as long as the connection lasts. Without a ceiling that is the entire
 * event firehose held in this server's memory, once per stalled connection, and a session may open
 * as many as it likes.
 *
 * A queuing strategy measured in bytes is what makes `desiredSize` mean "room left" rather than
 * "chunks left": the default strategy counts chunks with a high-water mark of one, which would call
 * an ordinary client stalled the moment two events landed between reads.
 */
const STREAM_BUFFER_BYTES = 256 * 1024;

/**
 * How many events one stream may miss before it is closed rather than kept.
 *
 * Dropping is recoverable — the client is told what it missed and reloads from the database, which
 * is what a subscriber that was not connected does anyway. Dropping forever is not: a connection
 * that has been stalled for thousands of events is not a client that is behind, it is a client that
 * is gone, and the socket is worth more than the guess. `EventSource` reconnects on its own, so
 * closing a genuinely-alive-but-slow one costs a reconnect and a reload.
 */
const MAX_DROPPED_BEFORE_CLOSE = 1_000;

/**
 * How many streams one session may hold open at once.
 *
 * The panel opens one per tab, so this is generous for a person and firm against a script. Counted
 * per session rather than per account, so an operator signed in on the till and the office machine
 * gets the allowance twice, and a single session cannot spend both.
 */
const MAX_STREAMS_PER_SESSION = 8;

/** Open streams per session id. Per-process, like every other counter of live things here. */
const openStreams = new Map<string, number>();

export async function GET(request: Request): Promise<Response> {
	const user = await currentUser();
	// One message for every refusal, the way the sign-in form has one: which gate stopped a caller is
	// not something a connection this route is about to close needs to be told.
	if (!user || (await sessionVerdict(user, { countsAsActivity: false })) !== "allowed") {
		return Response.json({ error: "missing_key", message: "Not signed in." }, { status: 401 });
	}

	const sessionId = user.sessionId;
	const alreadyOpen = openStreams.get(sessionId) ?? 0;
	if (alreadyOpen >= MAX_STREAMS_PER_SESSION) {
		logger.warn("Refused a panel event stream: too many open for this session", {
			open: alreadyOpen,
			limit: MAX_STREAMS_PER_SESSION,
		});
		// 429 rather than 401: the caller is who they say they are and reconnecting later will work,
		// which is exactly what `EventSource` does on its own.
		return Response.json({ error: "rate_limited", message: "Too many open streams." }, { status: 429 });
	}
	openStreams.set(sessionId, alreadyOpen + 1);

	/**
	 * Releases this connection's slot, once.
	 *
	 * Declared immediately after the slot is taken, and idempotent, because there are five ways this
	 * request can end and every one of them has to arrive here: the client disconnects (`abort`), the
	 * consumer cancels the body (`cancel`), a write finds the controller already closed, this route
	 * gives up on a client that stopped reading, or the setup below throws before a stream exists at
	 * all. Missing any of them leaks twice over — the subscriber stays registered on a bus that fans
	 * every event in the install to it, and the counter above never comes back down, so a session that
	 * lost eight streams that way could never open another.
	 */
	let released = false;
	const release = (): void => {
		if (released) {
			return;
		}
		released = true;
		const remaining = (openStreams.get(sessionId) ?? 1) - 1;
		if (remaining > 0) {
			openStreams.set(sessionId, remaining);
		} else {
			openStreams.delete(sessionId);
		}
	};

	// Proxies and load balancers close a connection that has been silent for a while, and the
	// browser would reconnect every time — a reconnect storm on an install that is simply quiet.
	// A comment line costs nothing and is ignored by the client. Read once per opened stream,
	// not per line written to it, so a saved change reaches only streams opened after it.
	//
	// Guarded because it is a database round trip standing between taking a slot and building the
	// stream that would eventually give it back: a transient failure here would otherwise cost the
	// session a slot permanently, which is a worse outcome than the failed request.
	let keepaliveMs: number;
	try {
		keepaliveMs = (await integerSetting("events.keepaliveSeconds")) * 1000;
	} catch (error) {
		release();
		throw error;
	}

	const encoder = new TextEncoder();

	// Assigned inside `start` and read by `close`, which has to be declared before the writer that
	// can trigger it. Both are undefined only in the window before `start` runs, which nothing else
	// can observe.
	let unsubscribe: (() => void) | undefined;
	let keepalive: NodeJS.Timeout | undefined;
	let close: () => void = release;

	const stream = new ReadableStream<Uint8Array>(
		{
			start(controller) {
				let open = true;
				/** Events not written since the last one that was, because there was no room. */
				let dropped = 0;

				close = (): void => {
					if (!open) {
						// Still released: reaching here with `open` already false is the ordinary case when
						// two endings race, and `release` is what must not be skipped.
						release();
						return;
					}
					open = false;
					if (keepalive) {
						clearInterval(keepalive);
					}
					unsubscribe?.();
					release();
					try {
						controller.close();
					} catch {
						// Already closed by the runtime when the client disconnected.
					}
				};

				const enqueue = (chunk: string): void => {
					try {
						controller.enqueue(encoder.encode(chunk));
					} catch {
						// The client went away between the check and the write. Ordinary — but it still has
						// to unsubscribe and give the slot back, which is why this closes rather than only
						// setting a flag and trusting an abort that may already have fired.
						close();
					}
				};

				const write = (chunk: string): void => {
					if (!open) {
						return;
					}

					// `desiredSize` is what the queue has room for, and it is the only thing on this side
					// that knows the client has stopped reading — `enqueue` succeeds regardless and simply
					// grows the queue, which is how an idle connection came to hold the whole firehose.
					const room = controller.desiredSize;
					if (room !== null && room <= 0) {
						dropped += 1;
						if (dropped >= MAX_DROPPED_BEFORE_CLOSE) {
							logger.warn("Closed a panel event stream that stopped reading", { dropped });
							close();
						}
						return;
					}

					if (dropped > 0) {
						// The client is reading again. Told what it missed rather than quietly resumed: it
						// has a gap in its view and the only honest repair is a reload, which is what a
						// subscriber that was never connected does anyway.
						const missed = dropped;
						dropped = 0;
						enqueue(`event: resync\ndata: ${JSON.stringify({ kind: "resync", missed })}\n\n`);
					}

					enqueue(chunk);
				};

				unsubscribe = subscribe((event: PanelEvent) => {
					// Named by kind so the client can attach one handler per concern rather than
					// switching over a payload field.
					write(`event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`);
				});

				keepalive = setInterval(() => write(": keepalive\n\n"), keepaliveMs);

				request.signal.addEventListener("abort", () => close());

				// Sent immediately so the browser's EventSource fires `open` rather than sitting in
				// CONNECTING until the first real event, which on a quiet install could be hours.
				write(": connected\n\n");
				logger.info("Panel event stream opened");
			},

			// The runtime discarding the body does not necessarily abort the request, so without this
			// the subscriber and the slot would both survive a stream nobody is reading any more.
			cancel() {
				close();
			},
		},
		// Bytes rather than chunks, so the high-water mark above is the number it reads as.
		new ByteLengthQueuingStrategy({ highWaterMark: STREAM_BUFFER_BYTES }),
	);

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
