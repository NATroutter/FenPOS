import "server-only";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { hashSecret } from "@/lib/auth/secrets";
import { prisma } from "@/lib/db";
import { type AuthenticatedAgent, handleAgentConnection } from "@/lib/link/agent-connection";
import { AGENT_LINK_PATH } from "@/lib/link/link-path";
import { closeAllLinks } from "@/lib/link/registry";
import { logger } from "@/lib/logger";

/**
 * The agent link endpoint.
 *
 * Agents dial in here and hold the connection open. The server never dials out, which is what
 * makes the whole design work behind shop NAT — and it means a agent has no listening socket
 * of its own for anyone to reach.
 *
 * Authentication happens during the HTTP upgrade, before a WebSocket exists. A request that
 * fails is answered with a plain HTTP response and the socket destroyed, so a misconfigured
 * agent gets a diagnosable status rather than a connection that opens and then silently dies.
 */

export { AGENT_LINK_PATH };

/**
 * Largest message accepted by the transport.
 *
 * Enforced by `ws` itself, so an oversized frame is rejected at the socket rather than after
 * being buffered into memory for the application to measure.
 */
const MAX_PAYLOAD_BYTES = 256 * 1024;

/**
 * Handles one upgrade request destined for the link endpoint.
 *
 * @param request the upgrade request
 * @param socket the raw socket
 * @param head the first packet of the upgraded stream
 */
export type LinkUpgradeHandler = (request: IncomingMessage, socket: Duplex, head: Buffer) => void;

/**
 * Builds the link endpoint's upgrade handler and publishes it on the server.
 *
 * Deliberately does **not** register an `upgrade` listener of its own. This process serves
 * the admin panel from the same port, and in development Next runs its hot-reload transport
 * over a WebSocket at `/_next/hmr`. A listener here that consumed every upgrade would take
 * that connection too — which manifests as pages that render but never become interactive,
 * with nothing in the browser console to explain it.
 *
 * Routing therefore stays in the process entry point, which owns the server and can pass
 * anything that is not ours back to Next. This function only supplies the handler for the
 * requests that are.
 *
 * Idempotent per server instance, so a development reload does not build a second one.
 *
 * @param server the HTTP server to publish the handler on
 */
export function attachAgentLink(server: Server): void {
	const marked = server as Server & { fenposLinkUpgrade?: LinkUpgradeHandler };
	if (marked.fenposLinkUpgrade) {
		return;
	}

	// `noServer` because the upgrade is routed by hand rather than by path matching inside ws.
	const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });

	marked.fenposLinkUpgrade = (request, socket, head) => {
		void routeUpgrade(wss, request, socket, head);
	};

	logger.info("Agent link endpoint attached", { path: AGENT_LINK_PATH });
}

/**
 * Routes and authenticates one upgrade request.
 *
 * @param wss the WebSocket server performing the handshake
 * @param request the upgrade request
 * @param socket the raw socket
 * @param head the first packet of the upgraded stream
 */
async function routeUpgrade(
	wss: WebSocketServer,
	request: IncomingMessage,
	socket: Duplex,
	head: Buffer,
): Promise<void> {
	const address = clientAddress(request);

	try {
		const token = bearerToken(request.headers.authorization);
		if (!token) {
			refuse(socket, 401, "Unauthorized");
			logger.warn("Link upgrade without a bearer token", { address });
			return;
		}

		const agent = await authenticate(token);
		if (!agent) {
			// One response for an unknown token and for a agent that was unpaired, so the
			// endpoint cannot be used to test whether a token was ever valid.
			refuse(socket, 401, "Unauthorized");
			logger.warn("Link upgrade with an unrecognised token", { address });
			return;
		}

		wss.handleUpgrade(request, socket, head, (ws) => {
			handleAgentConnection(ws, agent, address);
		});
	} catch (error) {
		logger.error("Failed to handle a link upgrade", error, { address });
		// The socket is half-upgraded and cannot be handed back to the HTTP server, so it is
		// destroyed rather than left consuming a file descriptor.
		socket.destroy();
	}
}

/**
 * Resolves a bearer token to the agent that holds it.
 *
 * The token is looked up by its deterministic hash in one indexed query. A agent whose
 * credential was cleared by unpairing has a null `tokenHash` and therefore cannot match,
 * which is what makes unpairing take effect on the next connection attempt.
 *
 * @param token the presented bearer token
 * @returns the agent, or null when the token matches none
 */
async function authenticate(token: string): Promise<AuthenticatedAgent | null> {
	const agent = await prisma.agent.findUnique({
		where: { tokenHash: hashSecret(token) },
		select: { id: true, name: true },
	});

	return agent ?? null;
}

/**
 * Extracts a bearer token from an Authorization header.
 *
 * @param header the raw header value
 * @returns the token, or null when the header is absent or not a bearer credential
 */
function bearerToken(header: string | undefined): string | null {
	if (!header) {
		return null;
	}
	const match = /^Bearer (.+)$/.exec(header.trim());
	return match ? match[1] : null;
}

/**
 * Answers an upgrade request with an HTTP error and closes the socket.
 *
 * @param socket the raw socket
 * @param status the HTTP status to report
 * @param message the status text
 */
function refuse(socket: Duplex, status: number, message: string): void {
	socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
	socket.destroy();
}

/**
 * Reads the caller's address from an upgrade request.
 *
 * Mirrors the reasoning in lib/request-context.ts: the rightmost `X-Forwarded-For` entry is
 * the one the nearest proxy observed and a client cannot append after it. Falls back to the
 * socket's own peer address, which is correct when nothing is proxying.
 *
 * @param request the upgrade request
 * @returns the caller's address
 */
function clientAddress(request: IncomingMessage): string {
	const forwarded = request.headers["x-forwarded-for"];
	const list = Array.isArray(forwarded) ? forwarded.join(",") : forwarded;

	if (list) {
		const hops = list
			.split(",")
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0);
		const nearest = hops.at(-1);
		if (nearest) {
			return nearest;
		}
	}

	return request.socket.remoteAddress ?? "unknown";
}

/**
 * Closes every agent connection.
 *
 * Called at shutdown so agents learn immediately that the server is going away and begin
 * reconnecting, rather than discovering it when a heartbeat eventually times out.
 *
 * @param reason text sent in the close frame
 * @returns how many connections were closed
 */
export function shutdownAgentLinks(reason: string): number {
	const closed = closeAllLinks(reason);
	if (closed > 0) {
		logger.info("Closed agent connections for shutdown", { count: closed });
	}
	return closed;
}
