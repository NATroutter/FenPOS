import "server-only";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { RateLimiter } from "@/lib/auth/rate-limit";
import { hashSecret } from "@/lib/auth/secrets";
import { prisma } from "@/lib/db";
import { type AuthenticatedAgent, handleAgentConnection } from "@/lib/link/agent-connection";
import { AGENT_LINK_PATH } from "@/lib/link/link-path";
import { closeAllLinks } from "@/lib/link/registry";
import { logger } from "@/lib/logger";
import { resolveAddress, UNKNOWN_ADDRESS } from "@/lib/request-context";
import { globalProxyTrust } from "@/lib/settings/settings-service";

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
 * How many upgrade attempts one address may make per minute.
 *
 * Keyed on the peer that opened the connection — read straight off the socket, with no settings
 * query — because the endpoint carries no credential, and a caller this is about to refuse must not
 * pay for a database read first. An agent needs a handful: one on start, and one per reconnect while
 * a flaky link settles, which the agent's own backoff already spaces out. Twenty a minute is far more
 * than that and far less than a flood.
 */
const upgradeLimiter = new RateLimiter({ limit: 20, windowMs: 60_000 });

/**
 * How many connections one agent may open per minute, whatever address it comes from.
 *
 * The address limiter above cannot do this job. It is handed back on a successful authentication,
 * and deliberately so: several tills behind one shop's router share an address, and a hostile
 * caller there must not be able to spend the real agent out of its own connection. The consequence
 * is that a caller holding a working credential is exempt from it entirely, and a connection is not
 * cheap — a settings read, an indexed lookup, an agent write, a device query and a dither of every
 * stored image at every paper width behind that agent, each time.
 *
 * So the credential gets a budget of its own, and this one is spent rather than returned. An agent's
 * ordinary retries never come close to it: one connection on start, one per drop, backed off
 * further each time the attempt fails. What does reach it is a caller that keeps *succeeding* —
 * `LinkClient` clears its backoff the moment a connection opens, before anything past the upgrade is
 * known to be good, so two processes sharing one credential, or a link that opens and drops right
 * after the handshake, can cycle close to once a second. Ten a minute catches that within ten
 * seconds rather than letting it run unbounded. The refusal then does the rest of the work on its
 * own: a 429 is not an open, so the backoff it leaves behind keeps growing on every attempt after,
 * and the fixed window has cleared again long before that growing gap lets the caller back in.
 */
const agentLimiter = new RateLimiter({ limit: 10, windowMs: 60_000 });

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
	// The socket's own peer, read synchronously and before anything else. Resolving the address a
	// forwarding header names costs a settings query, and doing that ahead of the limiter would
	// mean every attempt this endpoint is about to refuse paid for a database read first.
	const peer = request.socket.remoteAddress ?? UNKNOWN_ADDRESS;

	try {
		// Before the token is read, and so before the database is touched: the point of a limiter on an
		// unauthenticated path is that a caller over it costs nothing to turn away.
		const attempt = upgradeLimiter.consume(peer);
		if (!attempt.allowed) {
			refuse(socket, 429, "Too Many Requests");
			logger.warn("Link upgrade rate limit engaged", { address: peer, retryAfterMs: attempt.retryAfterMs });
			return;
		}

		const token = bearerToken(request.headers.authorization);
		if (!token) {
			refuse(socket, 401, "Unauthorized");
			logger.warn("Link upgrade without a bearer token", { address: peer });
			return;
		}

		const agent = await authenticate(token);
		if (!agent) {
			// One response for an unknown token and for a agent that was unpaired, so the
			// endpoint cannot be used to test whether a token was ever valid.
			refuse(socket, 401, "Unauthorized");
			logger.warn("Link upgrade with an unrecognised token", { address: peer });
			return;
		}

		// A working credential does not spend the address budget, so an agent reconnecting
		// repeatedly through a bad link is not refused by the address limiter above. What bounds
		// the credential itself is the per-agent budget below.
		upgradeLimiter.reset(peer);

		// Spent, not returned: this is the budget that actually bounds a credential holder.
		const budget = agentLimiter.consume(agent.id);
		if (!budget.allowed) {
			refuse(socket, 429, "Too Many Requests");
			logger.warn("Agent connection rate limit engaged", {
				agentId: agent.id,
				address: peer,
				retryAfterMs: budget.retryAfterMs,
			});
			return;
		}

		// Past every refusal, so the settings this costs are read once per accepted connection
		// rather than once per attempt. Recorded on the connection so a displacement can name both
		// ends, which on an install behind a proxy means the address the proxy names.
		const address = await clientAddress(request);

		wss.handleUpgrade(request, socket, head, (ws) => {
			handleAgentConnection(ws, agent, address);
		});
	} catch (error) {
		logger.error("Failed to handle a link upgrade", error, { address: peer });
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
 * Shares `resolveAddress` with the HTTP path rather than repeating its rules, so an agent's address
 * in the link log means the same thing as an operator's in the audit record. This side hands it the
 * socket's peer directly, where the HTTP path has to read the copy `server.ts` stamped — the same
 * value either way, and the same rule applied to it: a forwarding header is read only when that
 * peer is a configured trusted proxy.
 *
 * **Never throws.** Called from inside {@link routeUpgrade} once every refusal is past, reading
 * settings to do its job — a database hiccup at that point must cost an agent its address in the
 * log, not the connection it has already been granted.
 *
 * @param request the upgrade request
 * @returns the caller's address
 */
async function clientAddress(request: IncomingMessage): Promise<string> {
	const peer = request.socket.remoteAddress;

	try {
		const { address } = resolveAddress(
			(name) => {
				const value = request.headers[name];
				return Array.isArray(value) ? value.join(",") : value;
			},
			await globalProxyTrust(),
			peer,
		);

		return address;
	} catch (error) {
		logger.warn("Could not read the trusted address settings; using the socket's peer address", {
			reason: error instanceof Error ? error.message : String(error),
		});
		return peer ?? UNKNOWN_ADDRESS;
	}
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
