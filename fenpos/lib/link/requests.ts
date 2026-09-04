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
 *
 * There is no built-in default timeout: every caller passes one explicitly, sourced from whichever
 * setting governs its own kind of request (`link.commandTimeoutSeconds` for a device command,
 * `link.scanTimeoutSeconds` for a port scan) — the one constant this module used to carry of its
 * own, `DEFAULT_TIMEOUT_MS`, would otherwise have been a second, uncoordinated knob on top of those.
 */

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

/**
 * Phrases how long a request waited, for {@link RequestTimeoutError}'s message.
 *
 * Extracted rather than inlined for the same reason `signInThrottlePhrase` (`lib/auth/rate-limit.ts`)
 * and `minimumLengthPhrase` (`lib/auth/password-policy.ts`) were: a sentence built from a value an
 * operator configures is a sentence that can only be checked by pulling it out of the template
 * literal it would otherwise be buried in. `timeoutMs` now traces back to `link.commandTimeoutSeconds`
 * or `link.scanTimeoutSeconds`, so this is the one place their bounds meet the words shown for them.
 *
 * @param timeoutMs how long the request was allowed to take
 * @returns e.g. "15s"
 */
export function requestTimeoutPhrase(timeoutMs: number): string {
	return `${Math.round(timeoutMs / 1000)}s`;
}

/** Raised when an agent does not answer within the timeout. */
export class RequestTimeoutError extends Error {
	constructor(requestId: string, timeoutMs: number) {
		super(`The agent did not answer within ${requestTimeoutPhrase(timeoutMs)}.`);
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
 * `timeoutMs` has no built-in default — see the module doc comment above — so every caller states
 * it, typically read moments earlier from the setting that governs that caller's kind of request.
 *
 * @param requestId the identifier sent with the request
 * @param timeoutMs how long to wait before giving up
 * @returns the reply frame
 * @throws RequestTimeoutError when nothing answers in time
 */
export function awaitReply<T>(requestId: string, timeoutMs: number): Promise<T> {
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
 * Gives up a wait whose request never went out.
 *
 * {@link awaitReply} has to be called before `link.send`, so that a reply arriving on a fast link
 * finds somebody waiting for it. That ordering leaves a slot registered for a request that may then
 * fail to leave: `send` returns false on a socket that closed in between, and it throws outright
 * when the frame schema refuses the payload. Without this the slot stays in the map until its
 * timeout — a caller repeating the refused request fills the map with entries for requests that were
 * never sent — and the promise nobody is awaiting rejects into an unhandled rejection when the timer
 * eventually fires.
 *
 * The promise is deliberately left unsettled rather than rejected. Its only reference is the local
 * the caller is about to abandon; rejecting it would produce exactly the unhandled rejection this
 * exists to prevent.
 *
 * @param requestId the request that was never sent
 */
export function cancelReply(requestId: string): void {
	const waiter = pending.get(requestId);
	if (!waiter) {
		return;
	}
	pending.delete(requestId);
	clearTimeout(waiter.timer);
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
