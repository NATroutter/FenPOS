import "server-only";
import { randomUUID } from "node:crypto";

/**
 * Correlating a request sent to an agent with the reply that answers it.
 *
 * The link is one socket carrying everything, so a reply has to say which request it belongs
 * to. Without that, two operators scanning ports at the same moment would each be handed
 * whichever answer arrived first — usually the other one's.
 *
 * **Every wait is bounded.** An agent that dies mid-request never replies, and a promise nobody
 * settles is a request handler held open until the process restarts. The timeout is what turns
 * that into an error the panel can show.
 *
 * Held on `globalThis` so a development hot reload does not strand in-flight requests in an
 * unreachable map while new ones accumulate in a fresh one.
 */

/** How long any request waits before it is treated as unanswered. */
const DEFAULT_TIMEOUT_MS = 15_000;

interface Pending {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

const globalForRequests = globalThis as unknown as {
	fenposPendingRequests: Map<string, Pending> | undefined;
};

if (!globalForRequests.fenposPendingRequests) {
	globalForRequests.fenposPendingRequests = new Map();
}

const pending: Map<string, Pending> = globalForRequests.fenposPendingRequests;

/** Raised when an agent does not answer within the timeout. */
export class RequestTimeoutError extends Error {
	constructor(requestId: string, timeoutMs: number) {
		super(`The agent did not answer within ${Math.round(timeoutMs / 1000)}s.`);
		this.name = "RequestTimeoutError";
		this.requestId = requestId;
	}

	readonly requestId: string;
}

/**
 * Mints an identifier for a request.
 *
 * @returns an identifier no in-flight request is using
 */
export function newRequestId(): string {
	return randomUUID();
}

/**
 * Waits for the reply to a request.
 *
 * @param requestId the identifier sent with the request
 * @param timeoutMs how long to wait before giving up
 * @returns the reply frame
 * @throws RequestTimeoutError when nothing answers in time
 */
export function awaitReply<T>(requestId: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			pending.delete(requestId);
			reject(new RequestTimeoutError(requestId, timeoutMs));
		}, timeoutMs);

		// Not unref'd: the wait should keep the process from exiting mid-request in the same way
		// any other in-flight work does.
		pending.set(requestId, { resolve: resolve as (value: unknown) => void, reject, timer });
	});
}

/**
 * Delivers a reply to whoever is waiting for it.
 *
 * A reply with no waiter is dropped without complaint. That is what a reply arriving after its
 * timeout looks like, and it is also what a hostile agent inventing request ids looks like —
 * neither is worth an error, and both are made harmless by the same silence.
 *
 * @param requestId the request being answered
 * @param value the reply
 * @returns whether anyone was waiting
 */
export function settleReply(requestId: string, value: unknown): boolean {
	const waiter = pending.get(requestId);
	if (!waiter) {
		return false;
	}
	pending.delete(requestId);
	clearTimeout(waiter.timer);
	waiter.resolve(value);
	return true;
}

/**
 * Fails every request waiting on an agent that has gone away.
 *
 * Called when a connection closes. Without it, a panel action started just before a agent
 * dropped would sit until its timeout expired, showing a spinner for fifteen seconds over a
 * question that already has an answer.
 *
 * @param requestIds the requests to fail
 * @param reason what to report
 * @returns how many were failed
 */
export function failRequests(requestIds: Iterable<string>, reason: string): number {
	let failed = 0;
	for (const requestId of requestIds) {
		const waiter = pending.get(requestId);
		if (!waiter) {
			continue;
		}
		pending.delete(requestId);
		clearTimeout(waiter.timer);
		waiter.reject(new Error(reason));
		failed++;
	}
	return failed;
}
