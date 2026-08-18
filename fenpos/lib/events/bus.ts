import "server-only";
import type { ConnectionStatus, JobStatus, LogLevel } from "@/lib/domain/enums";

/**
 * The in-process event bus the panel's live view is driven from.
 *
 * Everything the panel shows live already passes through this process: an agent's frames arrive
 * on a socket this server owns, and every write goes through it too. So the bus is a plain
 * emitter rather than anything durable — there is nothing to persist, because a subscriber that
 * was not connected simply reloads and reads the database.
 *
 * **Publishing never throws and never blocks.** It is called from the link handler, in the middle
 * of processing a frame from a printer; a slow or broken subscriber must not be able to delay a
 * job update or take down the connection that produced it.
 *
 * Held on `globalThis` so a development hot reload does not strand subscribers on an emitter
 * nobody publishes to any more — which presents as a panel that silently stops updating.
 */

/** A job changed state. */
export interface JobEvent {
	kind: "job";
	jobId: string;
	status: JobStatus;
	agentId: string;
	deviceName: string;
	at: string;
}

/** An agent forwarded a log line. */
export interface LogEvent {
	kind: "log";
	id: string;
	at: string;
	level: LogLevel;
	message: string;
	agentId: string;
	deviceName: string | null;
}

/** An agent connected or disconnected. */
export interface AgentEvent {
	kind: "agent";
	agentId: string;
	agentName: string;
	online: boolean;
	at: string;
}

/** An agent reported its devices' observed state. */
export interface DeviceEvent {
	kind: "device";
	agentId: string;
	devices: { name: string; connection: ConnectionStatus; paused: boolean; queueDepth: number }[];
	at: string;
}

export type PanelEvent = JobEvent | LogEvent | AgentEvent | DeviceEvent;

/** Receives every event published while subscribed. */
export type Subscriber = (event: PanelEvent) => void;

const globalForBus = globalThis as unknown as {
	fenposEventSubscribers: Set<Subscriber> | undefined;
};

if (!globalForBus.fenposEventSubscribers) {
	globalForBus.fenposEventSubscribers = new Set();
}

const subscribers: Set<Subscriber> = globalForBus.fenposEventSubscribers;

/**
 * Registers a subscriber.
 *
 * @param subscriber called for every event until it unsubscribes
 * @returns a function that removes it
 */
export function subscribe(subscriber: Subscriber): () => void {
	subscribers.add(subscriber);
	return () => {
		subscribers.delete(subscriber);
	};
}

/**
 * Delivers an event to every subscriber.
 *
 * A subscriber that throws is removed rather than allowed to break the publish for everyone
 * behind it. Its stream is already broken by definition — whatever failed was its own write — and
 * keeping it would mean one dead browser tab could stop a printer's updates reaching every other.
 *
 * @param event what happened
 */
export function publish(event: PanelEvent): void {
	for (const subscriber of subscribers) {
		try {
			subscriber(event);
		} catch {
			subscribers.delete(subscriber);
		}
	}
}

/** Returns how many subscribers are listening, for the health probe. */
export function subscriberCount(): number {
	return subscribers.size;
}
