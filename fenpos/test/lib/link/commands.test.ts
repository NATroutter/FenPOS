import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/errors";
import { scanPorts, sendDeviceCommand, sendRawWrite } from "@/lib/link/commands";
import { type AgentLink, registerLink, unregisterLink } from "@/lib/link/registry";
import { setSetting } from "@/lib/settings/settings-service";
import { settled } from "@/test/settled";

/**
 * Tests for the timeouts `commands.ts` applies while waiting for an agent to answer.
 *
 * No test file covered this module before `link.commandTimeoutSeconds` and `link.scanTimeoutSeconds`
 * existed — its two timeouts were literal constants (`COMMAND_TIMEOUT_MS`, `SCAN_TIMEOUT_MS`)
 * exercised only indirectly, through whichever caller happened to hit them. What matters here is
 * that a configured value actually reaches `awaitReply`: each test proves the wait does not settle
 * before the configured deadline and does settle once it passes, the same two-sided check the
 * settings-expansion plan uses everywhere a hardcoded timeout becomes a setting — a test that only
 * checked "eventually rejects" would still pass against the old hardcoded constants.
 */

/** A link that never answers, standing in for an agent that has stopped responding. */
function unresponsiveLink(agentId: string): AgentLink {
	return {
		agentId,
		agentName: "agent",
		connectedAt: new Date(),
		send: () => true,
		close: () => {},
	};
}

beforeEach(async () => {
	await prisma.setting.deleteMany();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("sendDeviceCommand", () => {
	it("times a device command out at the configured number of seconds", async () => {
		vi.useFakeTimers();
		await setSetting("link.commandTimeoutSeconds", 5);
		const link = unresponsiveLink("agent-command-timeout");
		registerLink(link);

		const pending = sendDeviceCommand("agent-command-timeout", "device.pause", "till-1");

		// Four seconds in, still waiting; past five, rejected. Against the module's old hardcoded
		// fifteen-second COMMAND_TIMEOUT_MS this would still be pending at both points.
		await vi.advanceTimersByTimeAsync(4_000);
		expect(await settled(pending)).toBe(false);

		await vi.advanceTimersByTimeAsync(1_000);
		await expect(pending).rejects.toBeInstanceOf(ApiError);
		await expect(pending).rejects.toThrow(/did not answer/i);

		unregisterLink(link);
	});
});

describe("sendRawWrite", () => {
	it("times out at the same configured number of seconds as sendDeviceCommand", async () => {
		// Deliberately the same setting as the test above: sendRawWrite shares
		// commandTimeoutMs() with sendDeviceCommand rather than carrying its own constant.
		vi.useFakeTimers();
		await setSetting("link.commandTimeoutSeconds", 5);
		const link = unresponsiveLink("agent-raw-write-timeout");
		registerLink(link);

		const pending = sendRawWrite("agent-raw-write-timeout", "till-1", "AAAA");

		await vi.advanceTimersByTimeAsync(4_000);
		expect(await settled(pending)).toBe(false);

		await vi.advanceTimersByTimeAsync(1_000);
		await expect(pending).rejects.toBeInstanceOf(ApiError);

		unregisterLink(link);
	});
});

describe("scanPorts", () => {
	it("times a port scan out at the configured number of seconds", async () => {
		vi.useFakeTimers();
		await setSetting("link.scanTimeoutSeconds", 6);
		const link = unresponsiveLink("agent-scan-timeout");
		registerLink(link);

		const pending = scanPorts("agent-scan-timeout");

		// Five seconds in, still waiting; past six, rejected. Against the module's old hardcoded
		// twenty-second SCAN_TIMEOUT_MS this would still be pending at both points.
		await vi.advanceTimersByTimeAsync(5_000);
		expect(await settled(pending)).toBe(false);

		await vi.advanceTimersByTimeAsync(1_000);
		await expect(pending).rejects.toBeInstanceOf(ApiError);
		await expect(pending).rejects.toThrow(/did not answer the scan/i);

		unregisterLink(link);
	});
});
