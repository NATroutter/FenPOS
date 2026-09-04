import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import next from "next";
import { AGENT_LINK_PATH } from "./lib/link/link-path";
// Type-only and constant imports: neither pulls a `server-only` module into this process.
import type { LinkUpgradeHandler } from "./lib/link/link-server";
import { publishHttpServer } from "./lib/link/server-handle";
import { ownUpgrades } from "./lib/link/upgrade-owner";
// A bare string constant, so importing it here does not pull `request-context.ts` — and the
// `server-only` module it imports — into this process. See lib/link/server-handle.ts.
import { PEER_ADDRESS_HEADER } from "./lib/net/peer-header";

/**
 * Process entry point.
 *
 * FenPOS runs behind its own HTTP server rather than `next start`, because agents connect
 * over a WebSocket held open for the life of the connection. Next.js route handlers cannot
 * own a socket that outlives a request, so the upgrade must be handled by a server this
 * process controls.
 *
 * The server is created here and published before Next is prepared; `instrumentation.ts`
 * then attaches the link endpoint to it. Application logic stays out of this file, because
 * modules guarded with `server-only` cannot be imported from a plain Agent process — see
 * lib/link/server-handle.ts for why the handoff works the way it does.
 */

const dev = process.env.NODE_ENV !== "production";
const port = Number.parseInt(process.env.PORT ?? "3000", 10);
/**
 * The interface to bind.
 *
 * Deliberately not `HOSTNAME`: Docker sets that in every container, to the container id. Reading
 * it resolved that id to the container's own address and bound only there, so the port mapping
 * still worked from outside while nothing answered on loopback inside — which silently broke any
 * healthcheck, since those run within the container.
 */
const hostname = process.env.FENPOS_HOST ?? "0.0.0.0";

/**
 * How long to let in-flight work finish before forcing the process down.
 *
 * A shutdown that hangs is worse than one that gives up: a container runtime sends SIGKILL
 * regardless, and doing it deliberately keeps the timing predictable.
 */
const SHUTDOWN_GRACE_MS = 10_000;

/**
 * How long a caller may take to finish sending its headers, and then its whole request.
 *
 * Node ships `headersTimeout` at 60s and `requestTimeout` at 300s, which is generous for a panel
 * nobody uploads to over a modem and generous in the direction that costs this server: a socket
 * dribbling a request out is a socket held open, and holding many of them is the entire technique.
 * Tightened here rather than left at the defaults, with the upload path in mind — 120s is a long
 * time to spend sending a body this server will cap at 4 MiB anyway, and the one path where that is
 * not true is bounded by the same number no matter how it is framed.
 */
const HEADERS_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 120_000;

/**
 * The largest body accepted on any path but an upload, refused before Next parses it.
 *
 * Next applies `experimental.serverActions.bodySizeLimit` — 520 MB, sized for one authenticated
 * asset upload — to *every* server action, including `signIn`, `completeSetup` and
 * `verifyTwoFactor`. A server action is selected by the `Next-Action` header rather than by the URL,
 * so an unauthenticated caller can post half a gigabyte at any route in the application and have it
 * parsed before a credential is examined; against the compose files' `mem_limit: 1g` a dozen such
 * requests at once are an out-of-memory kill.
 *
 * 4 MiB clears everything this application legitimately posts outside an upload: form submissions,
 * the API's own bodies (64 KiB for a receipt, 4 KiB for a pairing request) and an avatar, whose own
 * `AVATAR_MAX_BYTES` is 2 MiB.
 */
const DEFAULT_MAX_REQUEST_BYTES = 4 * 1024 * 1024;

/**
 * The largest body accepted on the two paths that legitimately carry a file.
 *
 * Kept at or above `next.config.ts`'s `serverActions.bodySizeLimit` on purpose: this is a floor
 * under a cap, not a second cap. What actually decides an upload's fate is `assets.maxUploadMb`,
 * checked in the action and again in the service, and this must never become the thing that refuses
 * an upload first — that would turn a message the Assets tab words into a framework error page.
 */
const UPLOAD_MAX_REQUEST_BYTES = 520 * 1000 * 1000;

/**
 * The paths where an upload is expected.
 *
 * `/api/v1/assets` is the API's own upload route. `/assets` is where the panel's upload server
 * action is posted from, and a server action's URL is the page that invoked it. Everything else,
 * including every other panel page and every auth page, takes the default.
 */
const UPLOAD_PATHS: ReadonlySet<string> = new Set(["/assets", "/api/v1/assets"]);

/**
 * Installs signal handlers that close the server before the process exits.
 *
 * @param server the HTTP server to close
 */
function installShutdownHandlers(server: Server): void {
	let shuttingDown = false;

	const shutdown = (signal: string): void => {
		// Guarded because a container stop commonly sends SIGTERM and then SIGINT, and closing
		// twice would throw from inside a signal handler.
		if (shuttingDown) {
			return;
		}
		shuttingDown = true;
		process.stdout.write(`Received ${signal}, shutting down\n`);

		const forceExit = setTimeout(() => {
			process.stderr.write("Shutdown grace period elapsed, exiting\n");
			process.exit(1);
		}, SHUTDOWN_GRACE_MS);
		forceExit.unref();

		// Agent connections are closed by the application, which owns the registry. Reaching
		// it from here would require importing a server-only module, so the handler is
		// published on the server object by instrumentation instead.
		const closeLinks = (server as Server & { fenposCloseLinks?: (reason: string) => void }).fenposCloseLinks;
		closeLinks?.("server shutting down");

		// Same handoff as fenposCloseLinks above: the in-memory metric counters live behind a
		// server-only module, so instrumentation publishes the flush on the server object instead
		// of this file importing it directly. Awaited via .finally() rather than blocking the
		// signal handler, so a rejected or hanging flush still lets shutdown proceed — the grace
		// timer above is what bounds how long it can take.
		const flushMetrics = (server as Server & { fenposFlushMetrics?: () => Promise<void> }).fenposFlushMetrics;
		Promise.resolve(flushMetrics?.())
			.catch((error: unknown) => {
				process.stderr.write(`Could not flush metric counters during shutdown: ${String(error)}\n`);
			})
			.finally(() => {
				server.close((error) => {
					if (error) {
						process.stderr.write(`Error while closing the server: ${error.message}\n`);
						process.exit(1);
					}
					process.exit(0);
				});
			});
	};

	process.on("SIGTERM", () => shutdown("SIGTERM"));
	process.on("SIGINT", () => shutdown("SIGINT"));
}

/**
 * Replaces any inbound peer header with the address that actually opened the connection.
 *
 * A Next route handler or server action sees headers and nothing else: `headers()` has no socket
 * behind it, so without this the only thing the application could key its sign-in throttle, its
 * address allowlist and its audit rows on would be a header the caller wrote. Stamping the peer here
 * is what makes those controls measure the connection rather than the claim.
 *
 * **The delete is the security-relevant half.** Node lowercases every inbound header name into this
 * map, so one delete covers every capitalisation a caller could send, and the assignment that
 * follows can only be this server's own view. Written before the request reaches Next, so there is
 * no window in which a handler could read the caller's copy.
 *
 * An address the socket cannot report leaves the header absent rather than empty, which
 * `request-context.ts` reads as "no peer" and resolves to unknown — coarse, and the right direction
 * to be wrong in.
 *
 * @param request the request about to be handled
 */
function stampPeerAddress(request: IncomingMessage): void {
	delete request.headers[PEER_ADDRESS_HEADER];

	const peer = request.socket.remoteAddress;
	if (peer) {
		request.headers[PEER_ADDRESS_HEADER] = peer;
	}
}

/**
 * Refuses a body too large for its path before Next reads a byte of it.
 *
 * The framework's own limit is the wrong shape for this: it is one number for every server action,
 * and the number has to accommodate the largest legitimate upload, so the smallest and least
 * trusted forms in the application inherit the ceiling written for the largest and most trusted
 * one. Deciding by path here restores the difference.
 *
 * Two answers, because a body arrives two ways. A declared `Content-Length` over the cap is refused
 * outright. A body framed without one — `Transfer-Encoding: chunked` — has no length to check
 * before it is read, and this side has no way to stop reading it once Next owns the stream, so on a
 * non-upload path it is refused as `411 Length Required` rather than accepted on trust. Nothing this
 * application sends is framed that way; a browser posting a form always declares its length.
 *
 * @param request the incoming request
 * @param response where a refusal is written
 * @returns true when the request may proceed
 */
function withinBodyCap(request: IncomingMessage, response: ServerResponse): boolean {
	const path = new URL(request.url ?? "/", "http://localhost").pathname;
	const cap = UPLOAD_PATHS.has(path) ? UPLOAD_MAX_REQUEST_BYTES : DEFAULT_MAX_REQUEST_BYTES;

	const declared = request.headers["content-length"];
	if (declared !== undefined) {
		const length = Number(declared);
		if (Number.isFinite(length) && length > cap) {
			refuseRequest(request, response, 413, "Payload Too Large");
			return false;
		}
		return true;
	}

	if (request.headers["transfer-encoding"] !== undefined && cap !== UPLOAD_MAX_REQUEST_BYTES) {
		refuseRequest(request, response, 411, "Length Required");
		return false;
	}

	return true;
}

/**
 * Answers a request that will not be handled, without reading its body.
 *
 * `Connection: close` and the destroy are the point. Leaving the socket open invites the caller to
 * finish sending the body this just refused, which is the cost the refusal exists to avoid.
 *
 * @param request the request being refused
 * @param response the response to write
 * @param status the status code
 * @param message the status text, also used as the one-line body
 */
function refuseRequest(request: IncomingMessage, response: ServerResponse, status: number, message: string): void {
	response.writeHead(status, { "Content-Type": "text/plain", Connection: "close" });
	// Destroyed from the completion callback, not straight after `end`. `end` only queues the write,
	// so destroying the socket on the next line is a race the caller loses about half the time — it
	// gets a connection reset instead of the 413 that explains what happened, which is a refusal that
	// costs the same and diagnoses nothing.
	response.end(`${message}\n`, () => request.destroy());
}

async function main(): Promise<void> {
	const app = next({ dev, hostname, port });
	const handle = app.getRequestHandler();

	const server = createServer((request, response) => {
		stampPeerAddress(request);

		if (!withinBodyCap(request, response)) {
			return;
		}

		handle(request, response).catch((error: unknown) => {
			// Next resolves its own errors into responses; reaching here means the handler
			// itself rejected, so the socket would otherwise hang until the client times out.
			process.stderr.write(`Unhandled request error: ${String(error)}\n`);
			response.statusCode = 500;
			response.end();
		});
	});

	// Set before anything listens, so no connection is ever accepted under the defaults.
	server.headersTimeout = HEADERS_TIMEOUT_MS;
	server.requestTimeout = REQUEST_TIMEOUT_MS;

	// Published before prepare(), so the link endpoint is attached by instrumentation while
	// Next initialises rather than after the first request arrives.
	publishHttpServer(server);

	await app.prepare();

	// One upgrade listener for the whole process, routing by path.
	//
	// Next runs its development hot-reload transport over a WebSocket on this same port, so
	// anything that is not the agent link must be handed back to it. Consuming every upgrade
	// here breaks hot reload in a way that surfaces as pages rendering but never hydrating,
	// with no error in the browser to point at the cause.
	//
	// Registered through ownUpgrades rather than server.on, because Next later adds an upgrade
	// listener of its own to this same server and ends any agent's socket before the link can
	// answer it. See lib/link/upgrade-owner.ts for the whole story; the short version is that a
	// production build with that listener in place refuses every agent, silently.
	const upgradeToNext = app.getUpgradeHandler();

	ownUpgrades(server, (request, socket, head) => {
		const path = new URL(request.url ?? "/", "http://localhost").pathname;

		if (path === AGENT_LINK_PATH) {
			const handleLink = (server as Server & { fenposLinkUpgrade?: LinkUpgradeHandler }).fenposLinkUpgrade;
			if (handleLink) {
				handleLink(request, socket, head);
			} else {
				// The endpoint failed to attach, which is already logged. Refusing plainly beats
				// leaving a agent holding a socket that will never speak to it.
				socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
				socket.destroy();
			}
			return;
		}

		upgradeToNext(request, socket, head).catch((error: unknown) => {
			process.stderr.write(`Upgrade handling failed: ${String(error)}\n`);
			socket.destroy();
		});
	});

	installShutdownHandlers(server);

	server.listen(port, hostname, () => {
		process.stdout.write(`FenPOS server listening on http://${hostname}:${port}\n`);
	});
}

main().catch((error: unknown) => {
	process.stderr.write(`Failed to start: ${error instanceof Error ? error.stack : String(error)}\n`);
	process.exit(1);
});
