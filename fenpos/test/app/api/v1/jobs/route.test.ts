import { beforeEach, describe, expect, it } from "vitest";
import { GET } from "@/app/api/v1/jobs/route";
import { apiReadLimiter } from "@/lib/auth/rate-limit";
import { hashSecret } from "@/lib/auth/secrets";
import { prisma } from "@/lib/db";

/**
 * `GET /api/v1/jobs` — the caller's own job history.
 *
 * The test that matters most is the one asserting another key's jobs are absent. This endpoint
 * exists because a caller that loses a `jobId` to a network timeout currently has no way to ever
 * find that job again — but the fix must not become a way to read the receipts of whoever else
 * shares the printer. Scoping is by key, not by device, exactly as the single-job GET already is.
 */

let token: string;
let mineId: string;
let agentName: string;
let theirsJobId: string;

beforeEach(async () => {
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

	token = `fp_${Date.now()}_${Math.random()}`;
	const mine = await prisma.apiKey.create({
		data: {
			name: "till",
			keyHash: hashSecret(token),
			maskedHint: "abcd",
			permissions: { create: [{ permission: "jobs:read" }] },
			devices: { create: [{ deviceId: device.id }] },
		},
	});
	mineId = mine.id;
	apiReadLimiter.reset(mine.id);

	const theirs = await prisma.apiKey.create({
		data: { name: "other till", keyHash: hashSecret(`other-${token}`), maskedHint: "wxyz" },
	});

	// Three of mine, oldest first, and one belonging to somebody else on the same printer.
	for (const [index, status] of ["COMPLETED", "FAILED", "QUEUED"].entries()) {
		await prisma.job.create({
			data: {
				agentId: agent.id,
				deviceId: device.id,
				apiKeyId: mine.id,
				status,
				submittedAt: new Date(1_700_000_000_000 + index * 1000),
				lines: 10 + index,
			},
		});
	}
	const theirsJob = await prisma.job.create({
		data: { agentId: agent.id, deviceId: device.id, apiKeyId: theirs.id, status: "COMPLETED" },
	});
	theirsJobId = theirsJob.id;
});

/**
 * @param query the query string, without the leading `?`
 * @returns a request carrying the granted key's credential
 */
function requestWith(query = ""): Request {
	return new Request(`https://fenpos.test/api/v1/jobs${query ? `?${query}` : ""}`, {
		headers: { authorization: `Bearer ${token}` },
	});
}

describe("GET /api/v1/jobs", () => {
	it("lists the caller's own jobs, newest first", async () => {
		const body = await (await GET(requestWith())).json();

		expect(body.jobs).toHaveLength(3);
		expect(body.jobs[0].status).toBe("QUEUED");
		expect(body.jobs[2].status).toBe("COMPLETED");
	});

	it("never returns a job submitted by another key on the same printer", async () => {
		const body = await (await GET(requestWith())).json();

		const mine = await prisma.job.findMany({ where: { apiKeyId: mineId }, select: { id: true } });
		expect(body.jobs.map((job: { jobId: string }) => job.jobId).sort()).toEqual(mine.map((job) => job.id).sort());
	});

	it("carries the same fields as the single-job endpoint", async () => {
		const body = await (await GET(requestWith())).json();

		expect(body.jobs[0]).toMatchObject({
			jobId: expect.any(String),
			status: expect.any(String),
			agent: agentName,
			device: "kitchen",
			submittedAt: expect.any(String),
		});
	});

	it("pages with a cursor, without repeating or skipping a row", async () => {
		const first = await (await GET(requestWith("limit=2"))).json();
		expect(first.jobs).toHaveLength(2);
		expect(first.nextCursor).not.toBeNull();

		const second = await (await GET(requestWith(`limit=2&cursor=${first.nextCursor}`))).json();
		expect(second.jobs).toHaveLength(1);
		expect(second.nextCursor).toBeNull();

		const ids = [...first.jobs, ...second.jobs].map((job: { jobId: string }) => job.jobId);
		expect(new Set(ids).size).toBe(3);
	});

	it("filters by status", async () => {
		const body = await (await GET(requestWith("status=FAILED"))).json();

		expect(body.jobs).toHaveLength(1);
		expect(body.jobs[0].status).toBe("FAILED");
	});

	it("filters by device", async () => {
		expect((await (await GET(requestWith("device=kitchen"))).json()).jobs).toHaveLength(3);
		expect((await (await GET(requestWith("device=nowhere"))).json()).jobs).toHaveLength(0);
	});

	it("filters by agent", async () => {
		expect((await (await GET(requestWith(`agent=${agentName}`))).json()).jobs).toHaveLength(3);
		expect((await (await GET(requestWith("agent=nowhere"))).json()).jobs).toHaveLength(0);
	});

	// A cursor naming a row outside the caller's own filter is refused outright rather than silently
	// mishandled — see assertCursorInFilter. `apiKeyId` is unconditional in the route regardless, so
	// no version of this ever leaked another key's jobs; what changed is that a mistake like this now
	// gets a clear 400 instead of a page whose boundary quietly does not mean what it looks like it
	// means.
	it("refuses a cursor naming another key's job rather than silently paging around it", async () => {
		const response = await GET(requestWith(`cursor=${theirsJobId}`));

		expect(response.status).toBe(400);
		expect((await response.json()).error).toBe("invalid_query");
	});

	it("refuses a cursor naming no job at all", async () => {
		const response = await GET(requestWith("cursor=does-not-exist"));

		expect(response.status).toBe(400);
		expect((await response.json()).error).toBe("invalid_query");
	});

	// The cursor is checked against the *same* where the page query itself will use — a cursor that
	// names one of the caller's own jobs, but one this request's own status/agent/device/since filter
	// excludes, is exactly as wrong as one naming no row at all: Prisma would still resolve its
	// ordering position and silently skip past a row the caller never asked to exclude.
	it("refuses a cursor naming a job of the caller's own that this request's filter excludes", async () => {
		const completed = await prisma.job.findFirstOrThrow({ where: { apiKeyId: mineId, status: "COMPLETED" } });

		const response = await GET(requestWith(`status=FAILED&cursor=${completed.id}`));

		expect(response.status).toBe(400);
		expect((await response.json()).error).toBe("invalid_query");
	});

	it("treats an empty agent or device filter as absent rather than matching nothing", async () => {
		expect((await (await GET(requestWith("agent="))).json()).jobs).toHaveLength(3);
		expect((await (await GET(requestWith("device="))).json()).jobs).toHaveLength(3);
	});

	it("treats an empty cursor as absent rather than refusing it with invalid_query", async () => {
		const response = await GET(requestWith("cursor="));

		expect(response.status).toBe(200);
		expect((await response.json()).jobs).toHaveLength(3);
	});

	it("filters by submission time", async () => {
		const since = new Date(1_700_000_001_500).toISOString();

		expect((await (await GET(requestWith(`since=${since}`))).json()).jobs).toHaveLength(1);
	});

	it("refuses a status that is not one this system uses", async () => {
		const response = await GET(requestWith("status=PENDING"));

		expect(response.status).toBe(400);
		expect((await response.json()).error).toBe("invalid_query");
	});

	it("refuses a 'since' that is not a timestamp", async () => {
		const response = await GET(requestWith("since=yesterday"));

		expect(response.status).toBe(400);
		expect((await response.json()).error).toBe("invalid_query");
	});

	it("refuses a key without jobs:read", async () => {
		await prisma.apiKeyPermission.deleteMany({ where: { apiKeyId: mineId } });

		expect((await GET(requestWith())).status).toBe(403);
	});
});
