import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

/**
 * Exclusive ownership of a server's `upgrade` event.
 *
 * This exists because of how Next behaves as a custom server. Its request handler, the first
 * time an ordinary request passes through it, reads `request.socket.server` and registers an
 * `upgrade` listener of its own on it (`setupWebSocketHandler` in `next/dist/server/next.js`).
 * That listener resolves the upgrade's path against the app's routes and, when one matches,
 * calls `socket.end()`. `/api/agent-link` matches — the API catch-all route claims everything
 * under `/api` — so from the first page view onwards every agent's upgrade had two listeners:
 * ours, which yields at its first `await` to look the token up, and Next's, which ends the socket
 * in the meantime. The 101 written afterwards was a write after end that never left the process.
 *
 * The failure is invisible from inside: the link log shows nothing, because nothing in this
 * process failed. The agent sees a connection closed with no response, and a reverse proxy in
 * front reports the upstream closing prematurely and answers 502. It also never reproduces in
 * development — Next's route table is built lazily there, so the upgrade matches nothing — or
 * in the link tests, which run the link on a bare `http.Server` with no Next in it.
 *
 * Rather than argue with the listener after the fact, this keeps the server's upgrade event
 * single-owner: the given listener is registered, and any other upgrade listener added later is
 * removed the moment it is. The process entry point already forwards upgrades that are not the
 * agent link to Next's own handler, so Next loses nothing it would have done.
 *
 * Plain module on purpose, with no `server-only` guard: `server.ts` runs under tsx, outside
 * Next's bundler, and imports this directly.
 */

/** A handler for one upgrade request. */
export type UpgradeListener = (request: IncomingMessage, socket: Duplex, head: Buffer) => void;

/** The shape Node gives `newListener` handlers; the function type is what `EventEmitter` declares. */
type ListenerAdded = (event: string | symbol, listener: (...args: unknown[]) => void) => void;

/**
 * Registers `listener` for the server's upgrade requests and keeps it the only one that runs.
 *
 * `newListener` fires before the listener is attached, so the removal is deferred one tick.
 * No upgrade can be dispatched in between: the emitter attaches the listener synchronously after
 * `newListener` returns, and an upgrade only arrives from the event loop.
 *
 * @param server the HTTP server whose upgrade requests the listener owns
 * @param listener the one upgrade listener the server will ever run
 */
export function ownUpgrades(server: Server, listener: UpgradeListener): void {
	const guard: ListenerAdded = (event, added) => {
		if (event === "upgrade" && added !== listener) {
			process.nextTick(() => {
				server.removeListener("upgrade", added);
			});
		}
	};

	server.on("newListener", guard);
	server.on("upgrade", listener);
}
