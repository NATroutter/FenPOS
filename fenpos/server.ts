import { createServer, type Server } from "node:http";
import next from "next";
import { AGENT_LINK_PATH } from "./lib/link/link-path";
// Type-only and constant imports: neither pulls a `server-only` module into this process.
import type { LinkUpgradeHandler } from "./lib/link/link-server";
import { publishHttpServer } from "./lib/link/server-handle";

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
const hostname = process.env.HOSTNAME ?? "0.0.0.0";

/**
 * How long to let in-flight work finish before forcing the process down.
 *
 * A shutdown that hangs is worse than one that gives up: a container runtime sends SIGKILL
 * regardless, and doing it deliberately keeps the timing predictable.
 */
const SHUTDOWN_GRACE_MS = 10_000;

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

		server.close((error) => {
			if (error) {
				process.stderr.write(`Error while closing the server: ${error.message}\n`);
				process.exit(1);
			}
			process.exit(0);
		});
	};

	process.on("SIGTERM", () => shutdown("SIGTERM"));
	process.on("SIGINT", () => shutdown("SIGINT"));
}

async function main(): Promise<void> {
	const app = next({ dev, hostname, port });
	const handle = app.getRequestHandler();

	const server = createServer((request, response) => {
		handle(request, response).catch((error: unknown) => {
			// Next resolves its own errors into responses; reaching here means the handler
			// itself rejected, so the socket would otherwise hang until the client times out.
			process.stderr.write(`Unhandled request error: ${String(error)}\n`);
			response.statusCode = 500;
			response.end();
		});
	});

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
	const upgradeToNext = app.getUpgradeHandler();

	server.on("upgrade", (request, socket, head) => {
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
