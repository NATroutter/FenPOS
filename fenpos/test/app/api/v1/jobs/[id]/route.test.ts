import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DELETE, GET } from "@/app/api/v1/jobs/[id]/route";
import { hashSecret } from "@/lib/auth/secrets";
import { logsDb, prisma } from "@/lib/db";
import { type AgentLink, registerLink, unregisterLink } from "@/lib/link/registry";
import { setSetting } from "@/lib/settings/settings-service";

/**
 * `GET /api/v1/jobs/{id}` and `DELETE /api/v1/jobs/{id}` — one job, read and cancelled.
 *
 * Written with Task 11, which is when these two handlers first got a test of their own. The reason
 * to write one now is that the conversion to `apiRoute` did more than move the boilerplate: both
 * queries grew the columns their log line names, and `unknown_job` became a refusal rather than a
 * fault. Neither of those is visible to the coverage test, which reads source text and never calls a
 * handler.
 *
 * **The scoping tests are the point of the file.** A job belonging to another key must be
 * indistinguishable from one that never existed, in both handlers — otherwise a caller guessing ids
 * learns which ones are real, which is the only thing guessing ids is for.
 */

let token: string;
let otherToken: string;
let agentName: string;
let deviceName: string;
let jobId: string;
let othersJobId: string;
let link: AgentLink | null = null;

/**
 * @param id the job id to address
 * @param credential the bearer token to present
 * @returns the arguments to spread into either handler
 */
function call(id: string, credential = token): [Request, { params: Promise<{ id: string }> }] {
	return [
		new Request(`https://fenpos.test/api/v1/jobs/${id}`, { headers: { authorization: `Bearer ${credential}` } }),
		{ params: Promise.resolve({ id }) },
	];
}

beforeEach(async () => {
	if (link) {
		unregisterLink(link);
		link = null;
	}

	await logsDb.logEntry.deleteMany();
	await prisma.job.deleteMany();
	await prisma.apiKeyDevice.deleteMany();
	await prisma.apiKeyPermission.deleteMany();
	await prisma.apiKey.deleteMany();
	await prisma.device.deleteMany();
	await prisma.agent.deleteMany();
	await prisma.setting.deleteMany();

	const agent = await prisma.agent.create({ data: { name: `helsinki-${Date.now()}` } });
	agentName = agent.name;
	const device = await prisma.device.create({
		data: { agentId: agent.id, name: "kitchen", port: "COM3", columns: 42 },
	});
	deviceName = device.name;

	token = `fp_${Date.now()}_${Math.random()}`;
	const key = await prisma.apiKey.create({
		data: {
			name: "Till 4",
			keyHash: hashSecret(token),
			maskedHint: "abcd",
			permissions: { create: [{ permission: "jobs:read" }, { permission: "jobs:cancel" }] },
			devices: { create: [{ deviceId: device.id }] },
		},
	});

	otherToken = `fp_other_${Date.now()}_${Math.random()}`;
	const otherKey = await prisma.apiKey.create({
		data: {
			name: "Till 9",
			keyHash: hashSecret(otherToken),
			maskedHint: "wxyz",
			permissions: { create: [{ permission: "jobs:read" }, { permission: "jobs:cancel" }] },
			devices: { create: [{ deviceId: device.id }] },
		},
	});

	const job = await prisma.job.create({
		data: { agentId: agent.id, deviceId: device.id, apiKeyId: key.id, status: "QUEUED", lines: 24 },
	});
	jobId = job.id;

	const othersJob = await prisma.job.create({
		data: { agentId: agent.id, deviceId: device.id, apiKeyId: otherKey.id, status: "QUEUED" },
	});
	othersJobId = othersJob.id;

	link = {
		agentId: agent.id,
		agentName: agent.name,
		connectedAt: new Date(),
		address: "203.0.113.10",
		pending: new Set<string>(),
		send: () => true,
		close() {},
	};
	registerLink(link);
});

afterEach(() => {
	if (link) {
		unregisterLink(link);
		link = null;
	}
});

describe("GET /api/v1/jobs/{id}", () => {
	it("returns the job this key submitted", async () => {
		const response = await GET(...call(jobId));
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.jobId).toBe(jobId);
		expect(body.status).toBe("QUEUED");
		expect(body.agent).toBe(agentName);
		expect(body.device).toBe(deviceName);
		expect(body.lines).toBe(24);
	});

	it("answers the same way for another key's job and for one that never existed", async () => {
		// The whole reason `unknown_job` exists rather than a 403. A caller that could tell these apart
		// would learn which ids are real, which is the only thing guessing ids is for.
		const others = await GET(...call(othersJobId));
		const othersBody = await others.json();

		const absent = await GET(...call("no-such-job"));

		expect(others.status).toBe(404);
		expect(absent.status).toBe(404);
		expect(await absent.json()).toEqual(othersBody);
	});

	it("names the printer on the line an operator reads", async () => {
		// The `agentId`/`deviceId` columns this handler selects exist for this row and nothing else —
		// they are absent from the response body — so without an assertion here they could be dropped
		// with every other test still green. A read is suppressed by default, hence the setting: the
		// gate silences successful reads, and this is asking what such a row says when it is kept.
		await setSetting("logs.recordApiReads", true);

		await GET(...call(jobId));

		const rows = await logsDb.logEntry.findMany();
		expect(rows).toHaveLength(1);
		expect(rows[0].agentName).toBe(agentName);
		expect(rows[0].deviceName).toBe(deviceName);
	});

	it("records another key's job as a refusal rather than as a fault", async () => {
		// `unknown_job` is authorization wearing a 404, by this route's own words — so an operator
		// asking "what did this key get turned away from" has to see it beside the 403s. Recorded at
		// `ERROR` it would sit among the server's own faults instead, which is where nobody scanning
		// for probing would look.
		await GET(...call(othersJobId));

		const rows = await logsDb.logEntry.findMany();
		expect(rows).toHaveLength(1);
		expect(rows[0].level).toBe("WARN");
		expect(rows[0].message).toContain("unknown_job");
	});
});

describe("DELETE /api/v1/jobs/{id}", () => {
	it("asks the agent to cancel a queued job", async () => {
		const response = await DELETE(...call(jobId));
		const body = await response.json();

		expect(response.status).toBe(202);
		expect(body).toEqual({ jobId, status: "CANCELLING" });
	});

	it("writes nothing to the job row, because only the agent settles it", async () => {
		// A server that marked the job cancelled here would report a receipt as withdrawn while it was
		// being handed to a customer.
		await DELETE(...call(jobId));

		expect((await prisma.job.findUniqueOrThrow({ where: { id: jobId } })).status).toBe("QUEUED");
	});

	it("names the printer on the line an operator reads", async () => {
		// A cancellation is a command, so its row is always kept — and a row an operator cannot tie to
		// a printer is one they have to open the job to understand. Both columns are read straight from
		// the query the handler already makes.
		await DELETE(...call(jobId));

		const rows = await logsDb.logEntry.findMany();
		expect(rows).toHaveLength(1);
		expect(rows[0].agentName).toBe(agentName);
		expect(rows[0].deviceName).toBe(deviceName);
		// "Asked", not "cancelled": the agent decides, and the line must not claim otherwise.
		expect(rows[0].message).toContain("Asked");
		expect(rows[0].message).not.toContain("Cancelled");
	});

	it("refuses to cancel a job that has already finished", async () => {
		await prisma.job.update({ where: { id: jobId }, data: { status: "COMPLETED" } });

		const response = await DELETE(...call(jobId));

		expect(response.status).toBe(409);
		expect((await response.json()).error).toBe("job_not_cancellable");
	});

	it("reports an offline agent rather than claiming the job was cancelled", async () => {
		if (link) {
			unregisterLink(link);
			link = null;
		}

		const response = await DELETE(...call(jobId));

		expect(response.status).toBe(503);
		expect((await response.json()).error).toBe("agent_offline");
	});

	it("will not cancel another key's job", async () => {
		const response = await DELETE(...call(othersJobId));

		expect(response.status).toBe(404);
		expect((await response.json()).error).toBe("unknown_job");
		expect((await prisma.job.findUniqueOrThrow({ where: { id: othersJobId } })).status).toBe("QUEUED");
	});
});
