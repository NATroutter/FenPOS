import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { prisma } from "@/lib/db";
import { type AuthenticatedAgent, handleAgentConnection, pushDeviceConfig } from "@/lib/link/agent-connection";
import { PROTOCOL_VERSION, type ServerFrame } from "@/lib/link/protocol";
import type { AgentLink } from "@/lib/link/registry";
import { globalAgentSettings, globalJobSettings, setSetting } from "@/lib/settings/settings-service";

/**
 * Tests for the configuration pushed to an agent on connect.
 *
 * The property worth pinning down here is that the pushed `config.sync` frame carries the job
 * settings the operator has configured — installed alongside the device set and images by the
 * same "an agent needs this before any job arrives" argument `asset-sync.test.ts` covers for the
 * rasters. A real connection is not opened; `pushDeviceConfig` takes the link as a parameter for
 * exactly this reason, so the frame it builds can be inspected without a socket.
 */

/** A link that records what it was sent, standing in for a real socket. */
function fakeLink(agentId: string): AgentLink & { readonly frames: ServerFrame[] } {
	const frames: ServerFrame[] = [];
	return {
		agentId,
		agentName: "agent",
		connectedAt: new Date(),
		frames,
		send(frame) {
			frames.push(frame);
			return true;
		},
		close() {},
	};
}

beforeEach(async () => {
	await prisma.device.deleteMany();
	await prisma.agent.deleteMany();
	await prisma.setting.deleteMany();
});

describe("pushDeviceConfig", () => {
	it("carries the configured job settings", async () => {
		await setSetting("jobs.maxRecords", 500);

		const link = fakeLink("agent-1");
		await pushDeviceConfig(link, "agent-1");

		const [frame] = link.frames;
		if (frame?.type !== "config.sync") {
			throw new Error("expected a config.sync frame");
		}
		expect(frame.jobs).toEqual(await globalJobSettings());
	});

	it("carries the built-in job settings when nothing is stored", async () => {
		const link = fakeLink("agent-1");
		await pushDeviceConfig(link, "agent-1");

		const [frame] = link.frames;
		if (frame?.type !== "config.sync") {
			throw new Error("expected a config.sync frame");
		}
		expect(frame.jobs).toEqual(await globalJobSettings());
	});

	it("carries the configured agent timing settings", async () => {
		await setSetting("agent.queuePollMs", 250);

		const link = fakeLink("agent-1");
		await pushDeviceConfig(link, "agent-1");

		const [frame] = link.frames;
		if (frame?.type !== "config.sync") {
			throw new Error("expected a config.sync frame");
		}
		expect(frame.agent).toEqual(await globalAgentSettings());
	});

	it("carries the built-in agent timing settings when nothing is stored", async () => {
		const link = fakeLink("agent-1");
		await pushDeviceConfig(link, "agent-1");

		const [frame] = link.frames;
		if (frame?.type !== "config.sync") {
			throw new Error("expected a config.sync frame");
		}
		expect(frame.agent).toEqual(await globalAgentSettings());
	});
});

/**
 * A socket standing in for the `ws` connection `handleAgentConnection` is handed.
 *
 * `readyState`/`OPEN` mirror the `ws` library's own values (`OPEN` is `1`) since the connection
 * checks `socket.readyState !== socket.OPEN` rather than a fixed constant. Extending
 * `EventEmitter` gives it the `on`/`emit` pair the connection's `socket.on("message"/"pong"/"close"
 * /"error", ...)` calls need, without pulling in a real network socket.
 */
class FakeAgentSocket extends EventEmitter {
	readyState = 1;
	readonly OPEN = 1;
	readonly closes: { code: number; reason: string }[] = [];
	pings = 0;
	terminated = false;
	/** How many times `terminate()` was called — a leaked deadline can call it more than once. */
	terminateCalls = 0;

	send(_data: string): void {}

	close(code: number, reason: string): void {
		this.closes.push({ code, reason });
		this.readyState = 3;
	}

	terminate(): void {
		this.terminated = true;
		this.terminateCalls += 1;
		this.readyState = 3;
	}

	ping(): void {
		this.pings += 1;
	}
}

/** A well-formed `hello` frame, as JSON text — what a real agent's opening message looks like. */
function helloMessage(): string {
	return JSON.stringify({
		type: "hello",
		protocolVersion: PROTOCOL_VERSION,
		agentVersion: "1.0.0",
		platform: "test",
		hostname: "test-host",
	});
}

const agent = (id: string): AuthenticatedAgent => ({ id, name: "Agent" });

/**
 * Creates the row `onHello` updates once a agent's handshake completes.
 *
 * Without it, `prisma.agent.update` fails with "no record found" — caught and logged by
 * `onHello` rather than thrown, so the connection still proceeds, but the noise obscures a real
 * failure. Only the tests that get as far as sending `hello` need one.
 */
async function seedAgent(id: string): Promise<void> {
	await prisma.agent.create({ data: { id, name: id } });
}

/**
 * Tests for the three per-connection timeouts `handleAgentConnection` used to hold as literal
 * constants (`HANDSHAKE_TIMEOUT_MS`, `HEARTBEAT_INTERVAL_MS`, `HEARTBEAT_TIMEOUT_MS`) and now reads
 * from `link.handshakeTimeoutSeconds`, `link.heartbeatSeconds` and `link.heartbeatTimeoutSeconds`.
 *
 * Each setting is read once per connection, asynchronously, before the timer it governs is armed —
 * see `armHandshakeTimeout` and `startHeartbeat` in `agent-connection.ts`. Every test here checks
 * both sides of that: not yet acted on just before the configured deadline, and acted on just after
 * — a test that only checked the second half would still pass against the old hardcoded constants.
 */
describe("handleAgentConnection timeouts", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("drops a agent that never completes the handshake, at the configured number of seconds", async () => {
		vi.useFakeTimers();
		await setSetting("link.handshakeTimeoutSeconds", 5);

		const socket = new FakeAgentSocket();
		handleAgentConnection(socket as unknown as WebSocket, agent("agent-handshake-timeout"), "127.0.0.1");

		await vi.advanceTimersByTimeAsync(4_000);
		expect(socket.closes).toHaveLength(0);

		await vi.advanceTimersByTimeAsync(1_000);
		expect(socket.closes).toHaveLength(1);
		expect(socket.closes[0]?.reason).toBe("hello not received");
	});

	it("does not drop a agent that completes the handshake before the timeout", async () => {
		vi.useFakeTimers();
		await setSetting("link.handshakeTimeoutSeconds", 5);
		await seedAgent("agent-handshake-ok");

		const socket = new FakeAgentSocket();
		handleAgentConnection(socket as unknown as WebSocket, agent("agent-handshake-ok"), "127.0.0.1");
		// Emitted synchronously, before anything yields back to the connection's own async
		// handshake-timeout setup — so `helloReceived` is already true by the time that setup
		// checks it, regardless of how long the settings read underneath it takes.
		socket.emit("message", helloMessage(), false);

		await vi.advanceTimersByTimeAsync(5_000);
		expect(socket.closes).toHaveLength(0);
	});

	it("pings the agent at the configured heartbeat interval, not before", async () => {
		vi.useFakeTimers();
		await setSetting("link.heartbeatSeconds", 10);
		await setSetting("link.heartbeatTimeoutSeconds", 5);
		await seedAgent("agent-heartbeat-interval");

		const socket = new FakeAgentSocket();
		handleAgentConnection(socket as unknown as WebSocket, agent("agent-heartbeat-interval"), "127.0.0.1");
		socket.emit("message", helloMessage(), false);

		await vi.advanceTimersByTimeAsync(9_000);
		expect(socket.pings).toBe(0);

		await vi.advanceTimersByTimeAsync(1_000);
		expect(socket.pings).toBe(1);
	});

	it("terminates a agent that stops answering pings, at the configured grace period", async () => {
		vi.useFakeTimers();
		await setSetting("link.heartbeatSeconds", 10);
		await setSetting("link.heartbeatTimeoutSeconds", 5);
		await seedAgent("agent-heartbeat-grace");

		const socket = new FakeAgentSocket();
		handleAgentConnection(socket as unknown as WebSocket, agent("agent-heartbeat-grace"), "127.0.0.1");
		socket.emit("message", helloMessage(), false);

		await vi.advanceTimersByTimeAsync(10_000);
		expect(socket.pings).toBe(1);
		expect(socket.terminated).toBe(false);

		// The agent never answers with a pong. Four seconds of grace, still alive; past five,
		// terminated.
		await vi.advanceTimersByTimeAsync(4_000);
		expect(socket.terminated).toBe(false);

		await vi.advanceTimersByTimeAsync(1_000);
		expect(socket.terminated).toBe(true);
	});

	it("does not terminate a agent that answers pings within the grace period", async () => {
		vi.useFakeTimers();
		await setSetting("link.heartbeatSeconds", 10);
		await setSetting("link.heartbeatTimeoutSeconds", 5);
		await seedAgent("agent-heartbeat-answers");

		const socket = new FakeAgentSocket();
		handleAgentConnection(socket as unknown as WebSocket, agent("agent-heartbeat-answers"), "127.0.0.1");
		socket.emit("message", helloMessage(), false);

		await vi.advanceTimersByTimeAsync(10_000);
		expect(socket.pings).toBe(1);

		socket.emit("pong");
		await vi.advanceTimersByTimeAsync(5_000);
		expect(socket.terminated).toBe(false);
	});

	/**
	 * `link.heartbeatTimeoutSeconds` above `link.heartbeatSeconds` is exactly the inversion the
	 * description warns against but the store does not block — the two settings' bounds overlap
	 * (3–120 vs 5–300) and `fits()` validates one value at a time. Under that inversion, a tick's
	 * own grace deadline is still outstanding when the next tick fires. `startHeartbeat` used to
	 * overwrite `pongDeadline` there without clearing the old one first: a leaked timer handle,
	 * and — because the *next* tick's deadline is what a late pong would then clear instead — a
	 * stale deadline left free to fire later against whatever `alive` happens to be by then.
	 *
	 * Interval 5s, grace 9s: a second tick always lands before the first tick's deadline could
	 * fire. Two intervals send two pings with no reply at all; the third would only ever be
	 * reached if the connection were still open, which it should not be by then. `terminateCalls`
	 * — not just the `terminated` boolean the other heartbeat tests use — is what actually
	 * distinguishes this from the leak: a leaked deadline from the first tick and the *current*
	 * one from the second can each independently decide the agent is gone and call `terminate()`
	 * a second time; fixed, exactly one deadline is ever outstanding, so it fires exactly once.
	 */
	it("terminates a agent that never answers exactly once, even when the grace period exceeds the interval", async () => {
		vi.useFakeTimers();
		await setSetting("link.heartbeatSeconds", 5);
		await setSetting("link.heartbeatTimeoutSeconds", 9);
		await seedAgent("agent-heartbeat-inverted-silent");

		const socket = new FakeAgentSocket();
		handleAgentConnection(socket as unknown as WebSocket, agent("agent-heartbeat-inverted-silent"), "127.0.0.1");
		socket.emit("message", helloMessage(), false);

		// Two ticks (5s, 10s) with no pong in between — the second tick's own timing (10s) still
		// falls short of the first ping's nine-second grace (which elapses at 14s), so nothing has
		// fired yet.
		await vi.advanceTimersByTimeAsync(10_000);
		expect(socket.pings).toBe(2);
		expect(socket.terminated).toBe(false);

		// The first ping's grace elapses at 14s — one second after this stops short of it, still
		// nothing; one second past it, terminated.
		await vi.advanceTimersByTimeAsync(3_000);
		expect(socket.terminated).toBe(false);

		await vi.advanceTimersByTimeAsync(1_000);
		expect(socket.terminateCalls).toBe(1);

		// Run well past where a leaked second-tick deadline would have fired (19s) to confirm it
		// never gets the chance to call terminate() again.
		await vi.advanceTimersByTimeAsync(10_000);
		expect(socket.terminateCalls).toBe(1);
	});

	/**
	 * The companion healthy-agent case for the same inversion: a slow but responsive agent must
	 * not be dropped just because more than one tick's ping went unanswered before it finally
	 * replied, and must not be dropped again later either — the same absence-of-a-leak property,
	 * observed from the surviving-connection side rather than the exactly-once-termination side.
	 *
	 * Interval 5s, grace 14s, so up to two silent ticks still leave room to answer before the
	 * first of them times out. Three rounds, each leaving a different number of ticks unanswered
	 * (one, then two, then zero — answering right on the tick that armed the deadline) — a leaked
	 * deadline from an earlier round firing during a later one is what would drop this agent
	 * despite every ping eventually being answered.
	 */
	it("does not drop a agent that answers slowly, across several intervals, when the grace period exceeds the interval", async () => {
		vi.useFakeTimers();
		await setSetting("link.heartbeatSeconds", 5);
		await setSetting("link.heartbeatTimeoutSeconds", 14);
		await seedAgent("agent-heartbeat-inverted-slow");

		const socket = new FakeAgentSocket();
		handleAgentConnection(socket as unknown as WebSocket, agent("agent-heartbeat-inverted-slow"), "127.0.0.1");
		socket.emit("message", helloMessage(), false);

		// t=5s: tick1 (ping1) arms this round's deadline (fires t=19s if never answered).
		// t=10s: tick2 (ping2) — the deadline is still outstanding, so this one is skipped.
		await vi.advanceTimersByTimeAsync(10_000);
		expect(socket.pings).toBe(2);

		// t=12s: answered, two seconds ahead of the *next* tick and seven ahead of the deadline
		// this round actually armed.
		await vi.advanceTimersByTimeAsync(2_000);
		socket.emit("pong");
		expect(socket.terminated).toBe(false);

		// t=15s: tick3 (ping3) arms a fresh deadline (fires t=29s).
		// t=20s: tick4 (ping4) — skipped, deadline still outstanding.
		// t=25s: tick5 (ping5) — skipped, deadline still outstanding. Two full ticks now
		// unanswered on top of the one that armed it — exactly the count a leaked earlier
		// deadline would have kept firing against, if one had survived past t=19s.
		await vi.advanceTimersByTimeAsync(13_000);
		expect(socket.pings).toBe(5);
		expect(socket.terminated).toBe(false);

		// t=27s: answered, well ahead of the t=29s deadline.
		await vi.advanceTimersByTimeAsync(2_000);
		socket.emit("pong");
		expect(socket.terminated).toBe(false);

		// t=30s: tick6 (ping6) arms yet another fresh deadline (fires t=44s).
		await vi.advanceTimersByTimeAsync(3_000);
		expect(socket.pings).toBe(6);

		// t=32s: answered immediately this time, right on the tick that armed it.
		await vi.advanceTimersByTimeAsync(2_000);
		socket.emit("pong");
		expect(socket.terminated).toBe(false);
		expect(socket.terminateCalls).toBe(0);
	});
});
