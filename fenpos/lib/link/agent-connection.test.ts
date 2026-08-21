import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { pushDeviceConfig } from "@/lib/link/agent-connection";
import type { ServerFrame } from "@/lib/link/protocol";
import type { AgentLink } from "@/lib/link/registry";
import { globalJobSettings, setSetting } from "@/lib/settings/settings-service";

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
});
