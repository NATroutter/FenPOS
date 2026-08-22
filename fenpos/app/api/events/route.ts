import { getCurrentSession } from "@/lib/auth/session-cookie";
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
 * **Admin session only.** The stream carries job identifiers, device names and log lines from
 * every site in the install, which is more than any API key is ever granted.
 */

/** Never cached and never prerendered: the whole point is that it does not end. */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
	if (!(await getCurrentSession())) {
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
