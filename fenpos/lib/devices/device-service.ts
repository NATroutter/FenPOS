import "server-only";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { Codepage, type ConnectionStatus, FlowControl, Linefeed, Parity, UnsupportedPolicy } from "@/lib/domain/enums";
import { nameSchema } from "@/lib/domain/naming";
import { ApiError } from "@/lib/errors";
import { pushDeviceConfig } from "@/lib/link/agent-connection";
import { getAgentStatus } from "@/lib/link/device-status";
import { getLink } from "@/lib/link/registry";
import { logger } from "@/lib/logger";

/**
 * Printer lifecycle: creating, editing, deleting, and keeping agents in step.
 *
 * **Every change pushes the whole device set to the agent that holds it.** A change saved here
 * and not pushed is the worst kind of bug in this system: the panel shows the new port, the
 * printer keeps using the old one, and nothing anywhere says the two disagree. Pushing is
 * therefore part of the write rather than something a caller remembers to do afterwards.
 *
 * The push is best effort and deliberately not part of the transaction. An agent that is offline
 * cannot be told, and refusing to save a configuration change because a shop's internet is down
 * would make the panel unusable exactly when someone is trying to fix something. The agent
 * receives a full snapshot on its next connection, which is what makes that safe.
 */

/** A printer as the Devices tab displays it. */
export interface DeviceSummary {
	id: string;
	agentId: string;
	agentName: string;
	name: string;
	port: string;
	baudRate: number;
	columns: number;
	codepage: string;
	paused: boolean;
	/** What the agent last reported, or null when it has said nothing. */
	observed: {
		connection: ConnectionStatus;
		queueDepth: number;
	} | null;
}

/**
 * What an operator may set on a printer.
 *
 * The bounds mirror `deviceConfigSchema` in the link protocol, because a row that cannot be
 * serialised onto the wire is skipped by the config push with a log line nobody is watching —
 * which looks exactly like a printer that will not connect. Refusing it at the form is the only
 * place the operator can still do something about it.
 */
export const deviceInputSchema = z.object({
	name: nameSchema,
	port: z.string().min(1, "A port is required.").max(256),
	baudRate: z.number().int().min(50).max(4_000_000),
	dataBits: z.number().int().min(5).max(8),
	stopBits: z.number().int().min(1).max(2),
	parity: Parity.schema,
	flowControl: FlowControl.schema,
	writeTimeoutMs: z.number().int().min(100).max(120_000),
	autoConnect: z.boolean(),
	autoReconnect: z.boolean(),
	reconnectDelaySeconds: z.number().int().min(1).max(3600),
	columns: z.number().int().min(1).max(255),
	codepage: Codepage.schema,
	onUnsupported: UnsupportedPolicy.schema,
	defaultWrap: z.boolean(),
	defaultLinefeed: Linefeed.schema,
	maxQueueDepth: z.number().int().min(1).max(10_000),
});

export type DeviceInput = z.infer<typeof deviceInputSchema>;

/** Sensible starting point for a new printer: 80mm thermal on a typical USB adapter. */
export const DEVICE_DEFAULTS: Omit<DeviceInput, "name" | "port"> = {
	baudRate: 9600,
	dataBits: 8,
	stopBits: 1,
	parity: "NONE",
	flowControl: "NONE",
	writeTimeoutMs: 5000,
	autoConnect: true,
	autoReconnect: true,
	reconnectDelaySeconds: 5,
	columns: 42,
	codepage: "CP858",
	onUnsupported: "REJECT",
	defaultWrap: true,
	defaultLinefeed: "LF",
	maxQueueDepth: 100,
};

/**
 * Lists every printer, with what its agent last reported about it.
 *
 * @returns printers ordered by agent then name
 */
export async function listDevices(): Promise<DeviceSummary[]> {
	const rows = await prisma.device.findMany({
		orderBy: [{ agent: { name: "asc" } }, { name: "asc" }],
		include: { agent: { select: { id: true, name: true } } },
	});

	return rows.map((row) => {
		const observed = getAgentStatus(row.agentId).get(row.name);
		return {
			id: row.id,
			agentId: row.agentId,
			agentName: row.agent.name,
			name: row.name,
			port: row.port,
			baudRate: row.baudRate,
			columns: row.columns,
			codepage: row.codepage,
			paused: row.paused,
			observed: observed ? { connection: observed.connection, queueDepth: observed.queueDepth } : null,
		};
	});
}

/**
 * Adds a printer behind an agent.
 *
 * @param agentId the agent that will drive it
 * @param input the configuration
 * @returns the new printer's id
 * @throws ApiError when the agent is unknown or the name is taken
 */
export async function createDevice(agentId: string, input: DeviceInput): Promise<string> {
	const parsed = parse(input);

	const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { id: true } });
	if (!agent) {
		throw new ApiError("unknown_agent", "That agent no longer exists.");
	}

	await requireNameFree(agentId, parsed.name, null);

	const device = await prisma.device.create({
		data: { agentId, ...parsed },
		select: { id: true },
	});

	logger.info("Device created", { agentId, deviceId: device.id, deviceName: parsed.name });
	await push(agentId);
	return device.id;
}

/**
 * Changes a printer's configuration.
 *
 * @param deviceId the printer to change
 * @param input the new configuration
 * @throws ApiError when the printer is unknown or the new name is taken
 */
export async function updateDevice(deviceId: string, input: DeviceInput): Promise<void> {
	const parsed = parse(input);

	const existing = await prisma.device.findUnique({
		where: { id: deviceId },
		select: { id: true, agentId: true, name: true },
	});
	if (!existing) {
		throw new ApiError("unknown_device", "That printer no longer exists.");
	}

	await requireNameFree(existing.agentId, parsed.name, deviceId);

	await prisma.device.update({ where: { id: deviceId }, data: parsed });

	logger.info("Device updated", { deviceId, deviceName: parsed.name, agentId: existing.agentId });
	await push(existing.agentId);
}

/**
 * Removes a printer and its job history.
 *
 * @param deviceId the printer to remove
 * @throws ApiError when it is already gone
 */
export async function deleteDevice(deviceId: string): Promise<void> {
	const existing = await prisma.device.findUnique({
		where: { id: deviceId },
		select: { agentId: true, name: true },
	});
	if (!existing) {
		throw new ApiError("unknown_device", "That printer no longer exists.");
	}

	await prisma.device.delete({ where: { id: deviceId } });

	logger.info("Device deleted", { deviceId, deviceName: existing.name, agentId: existing.agentId });
	await push(existing.agentId);
}

/**
 * Holds or releases printing on a printer.
 *
 * Recorded in the database as well as sent to the agent, because pausing is a decision an
 * operator made rather than a state a machine is in: it must survive the agent restarting, and
 * the agent learns it again from the next config push.
 *
 * @param deviceId the printer
 * @param paused whether to hold printing
 * @throws ApiError when the printer is unknown
 */
export async function setDevicePaused(deviceId: string, paused: boolean): Promise<void> {
	const existing = await prisma.device.findUnique({
		where: { id: deviceId },
		select: { agentId: true, name: true },
	});
	if (!existing) {
		throw new ApiError("unknown_device", "That printer no longer exists.");
	}

	await prisma.device.update({ where: { id: deviceId }, data: { paused } });
	await push(existing.agentId);
}

/**
 * Returns a printer with the agent that holds it, for actions that need both.
 *
 * @param deviceId the printer
 * @returns its id, name and agent
 * @throws ApiError when it is unknown
 */
export async function requireDevice(deviceId: string): Promise<{
	id: string;
	name: string;
	agentId: string;
}> {
	const device = await prisma.device.findUnique({
		where: { id: deviceId },
		select: { id: true, name: true, agentId: true },
	});
	if (!device) {
		throw new ApiError("unknown_device", "That printer no longer exists.");
	}
	return device;
}

/** Validates input, reporting the first problem in the operator's terms. */
function parse(input: DeviceInput): DeviceInput {
	const result = deviceInputSchema.safeParse(input);
	if (!result.success) {
		throw new ApiError("invalid_type", result.error.issues[0]?.message ?? "That configuration is not valid.");
	}
	return result.data;
}

/**
 * Refuses a name already used behind the same agent.
 *
 * Uniqueness is per agent rather than global, which is the point of agent-scoped API paths: every
 * site can have a printer called `kitchen` without coordinating names across the whole install.
 *
 * @param agentId the agent to check within
 * @param name the candidate name
 * @param exceptDeviceId a printer allowed to keep its own name, when editing
 */
async function requireNameFree(agentId: string, name: string, exceptDeviceId: string | null): Promise<void> {
	const clash = await prisma.device.findFirst({
		where: { agentId, name, ...(exceptDeviceId ? { NOT: { id: exceptDeviceId } } : {}) },
		select: { id: true },
	});
	if (clash) {
		throw new ApiError("name_taken", `This agent already has a printer called '${name}'.`);
	}
}

/**
 * Sends an agent its device set, if it is connected.
 *
 * Failure is logged, never thrown. The change is already saved and the agent converges on its
 * next connection; failing the operator's action here would suggest the change did not happen.
 *
 * @param agentId the agent to update
 */
async function push(agentId: string): Promise<void> {
	const link = getLink(agentId);
	if (!link) {
		logger.info("Agent is offline; it will get the new configuration when it reconnects", { agentId });
		return;
	}
	await pushDeviceConfig(link, agentId);
}
