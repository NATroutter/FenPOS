import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiRoute } from "@/lib/api/api-route";
import { hashSecret } from "@/lib/auth/secrets";
import { logsDb, prisma } from "@/lib/db";
import { ApiError } from "@/lib/errors";
import { requireGrantedDevice } from "@/lib/keys/authenticate";
import { setSetting } from "@/lib/settings/settings-service";

/**
 * The envelope every keyed v1 route runs inside.
 *
 * What is worth pinning down is not that a line is written but *which* line: the level is the only
 * field carrying the outcome, so a refusal recorded as `ERROR` and a fault recorded as `WARN` are
 * both defects an operator would have to read the message to notice. The other property under test
 * is the read gate's placement — `logs.recordApiReads` suppresses successful reads and nothing else,
 * which only holds if the gate is consulted after the outcome is known rather than before the
 * handler runs.
 *
 * Real registry ids throughout, and real permission and grant checks against a migrated database:
 * the wrapper reads the permission out of the registry, so a test naming an invented id would prove
 * nothing about the routes that actually exist.
 */

/** A write. `print` is the permission its registry entry declares. */
const PRINT = "api:POST /v1/print/{agent}/{device}";

/** A read. `jobs:read` is the permission its registry entry declares. */
const JOBS = "api:GET /v1/jobs";

/** A key holding both permissions and a grant for `kitchen`. */
let token: string;
let keyId: string;

/** A key holding nothing at all: authenticates, and is refused by every permission check. */
let unarmedToken: string;

let agentName: string;

beforeEach(async () => {
	await logsDb.logEntry.deleteMany();
	await prisma.apiKeyDevice.deleteMany();
	await prisma.apiKeyPermission.deleteMany();
	await prisma.apiKey.deleteMany();
	await prisma.device.deleteMany();
	await prisma.agent.deleteMany();
	// `logs.recordApiReads` falls back to false, so clearing this is what puts the gate in its
	// default position for every test below rather than in whatever the previous one left.
	await prisma.setting.deleteMany();

	const agent = await prisma.agent.create({ data: { name: `helsinki-${Date.now()}` } });
	agentName = agent.name;
	const device = await prisma.device.create({
		data: { agentId: agent.id, name: "kitchen", port: "COM3", columns: 42 },
	});

	token = `fp_${Date.now()}_${Math.random()}`;
	const key = await prisma.apiKey.create({
		data: {
			name: "Till 4",
			keyHash: hashSecret(token),
			maskedHint: "ab12",
			permissions: { create: [{ permission: "jobs:submit" }, { permission: "jobs:read" }] },
			devices: { create: [{ deviceId: device.id }] },
		},
	});
	keyId = key.id;

	unarmedToken = `fp_unarmed_${Date.now()}_${Math.random()}`;
	await prisma.apiKey.create({
		data: { name: "Unarmed till", keyHash: hashSecret(unarmedToken), maskedHint: "wxyz" },
	});
});

/** The print route's path parameters, named once so every call below agrees with `PrintParams`. */
type PrintParams = { agent: string; device: string };

/**
 * @param credential the bearer token to present
 * @param device the device to address
 * @returns the arguments to spread into a print route handler
 */
function printCall(credential = token, device = "kitchen"): [Request, { params: Promise<PrintParams> }] {
	return [
		new Request(`https://fenpos.test/api/v1/print/${agentName}/${device}`, {
			method: "POST",
			headers: { authorization: `Bearer ${credential}` },
		}),
		{ params: Promise.resolve({ agent: agentName, device }) },
	];
}

/**
 * @param credential the bearer token to present
 * @returns a request for the jobs listing, which has no path parameters
 */
function jobsRequest(credential = token): Request {
	return new Request("https://fenpos.test/api/v1/jobs", { headers: { authorization: `Bearer ${credential}` } });
}

/** @returns every line recorded so far */
async function lines() {
	return logsDb.logEntry.findMany();
}

describe("apiRoute", () => {
	it("logs INFO for a successful write", async () => {
		const route = apiRoute<PrintParams>(PRINT, async () => ({
			response: Response.json({ jobId: "j1", status: "QUEUED", lines: 24 }, { status: 202 }),
			message: "Printed 24 lines to 'kitchen'",
			target: { deviceName: "kitchen" },
		}));

		const response = await route(...printCall());

		expect(response.status).toBe(202);
		const rows = await lines();
		expect(rows).toHaveLength(1);
		expect(rows[0].level).toBe("INFO");
		// Written for a person, not assembled from the route id.
		expect(rows[0].message).toContain("Printed 24 lines to 'kitchen'");
		expect(rows[0].message).not.toContain("/v1/print");
		// `LogEntry` has no denormalised column for a key's name, so the line has to carry it in the
		// message or it stops meaning anything the moment the key is deleted.
		expect(rows[0].message).toContain("Till 4");
		expect(rows[0].apiKeyId).toBe(keyId);
		expect(rows[0].deviceName).toBe("kitchen");
	});

	it("logs nothing for a successful read when recordApiReads is off", async () => {
		const route = apiRoute(JOBS, async () => ({
			response: Response.json({ jobs: [], nextCursor: null }),
			message: "Listed 0 jobs",
		}));

		expect((await route(jobsRequest())).status).toBe(200);
		expect(await lines()).toHaveLength(0);

		// The positive control. Without it this test would pass just as well against a wrapper that
		// never logged anything at all, which is the failure it is least able to notice.
		await setSetting("logs.recordApiReads", true);

		expect((await route(jobsRequest())).status).toBe(200);
		const rows = await lines();
		expect(rows).toHaveLength(1);
		expect(rows[0].level).toBe("INFO");
		expect(rows[0].message).toContain("Listed 0 jobs");
	});

	it("logs a refused read even when recordApiReads is off", async () => {
		// The gate suppresses noise, not evidence. Goes red if the read check is applied before the
		// outcome is known — which is the natural way to write it and the wrong one.
		const handler = vi.fn();
		const route = apiRoute(JOBS, handler);

		const response = await route(jobsRequest(unarmedToken));

		expect(response.status).toBe(403);
		// The refusal happened in the wrapper, so the handler never ran and the request produced
		// nothing but this line: if it is dropped, the probe leaves no trace at all.
		expect(handler).not.toHaveBeenCalled();
		const rows = await lines();
		expect(rows).toHaveLength(1);
		expect(rows[0].level).toBe("WARN");
		expect(rows[0].message).toContain("insufficient_permission");
	});

	it("logs WARN for insufficient permission", async () => {
		const route = apiRoute<PrintParams>(PRINT, async () => {
			throw new Error("the handler must not run for a caller the wrapper refused");
		});

		const response = await route(...printCall(unarmedToken));

		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({ error: "insufficient_permission" });
		const rows = await lines();
		expect(rows).toHaveLength(1);
		expect(rows[0].level).toBe("WARN");
		expect(rows[0].apiKeyId).toBe((await prisma.apiKey.findFirstOrThrow({ where: { name: "Unarmed till" } })).id);
	});

	it("logs WARN for an unknown device", async () => {
		// The wrapper never learns what a device is. `requireGrantedDevice` stays in the handler and
		// throws `unknown_device`; the wrapper catches a 404 and has to classify it as the refusal it
		// actually is — per `lib/errors.ts`, that code exists so a caller cannot map the install's
		// printers, which makes it authorization wearing a 404's clothes.
		const route = apiRoute<PrintParams>(PRINT, async ({ key, params }) => {
			await requireGrantedDevice(key, params.agent, params.device);
			throw new Error("the grant check must have refused before this line");
		});

		const response = await route(...printCall(token, "ghost"));

		expect(response.status).toBe(404);
		expect(await response.json()).toMatchObject({ error: "unknown_device" });
		const rows = await lines();
		expect(rows).toHaveLength(1);
		expect(rows[0].level).toBe("WARN");
		expect(rows[0].message).toContain("unknown_device");
	});

	it("logs ERROR for a validation failure", async () => {
		const route = apiRoute<PrintParams>(PRINT, async () => {
			throw new ApiError("invalid_type", "'bytes' is not valid base64.");
		});

		const response = await route(...printCall());

		expect(response.status).toBe(400);
		const rows = await lines();
		expect(rows).toHaveLength(1);
		expect(rows[0].level).toBe("ERROR");
		expect(rows[0].message).toContain("invalid_type");
	});

	it("logs ERROR for a handler that threw something other than an ApiError", async () => {
		// The third row of the level table, and the only branch of either module nothing else reaches.
		// Tests 4 and 5 do hand the wrapper handlers that throw plain `Error`s, but by construction
		// those handlers never run — that is exactly what they assert — so neither pins this path.
		const route = apiRoute<PrintParams>(PRINT, async () => {
			throw new TypeError("Cannot read properties of undefined (reading 'columns')");
		});

		const response = await route(...printCall());

		expect(response.status).toBe(500);
		expect(await response.json()).toMatchObject({ error: "internal_error" });
		const rows = await lines();
		expect(rows).toHaveLength(1);
		expect(rows[0].level).toBe("ERROR");
		// The row has to name the code the caller was actually answered with, or an operator matching
		// a complaint against the log is comparing two different accounts of one request.
		expect(rows[0].message).toContain("internal_error");
		// And it has to keep the detail the caller is deliberately never shown: `toErrorResponse`
		// returns a bare `internal_error`, so this row is where the reason survives for a person.
		expect(rows[0].message).toContain("reading 'columns'");
	});

	it("still answers a successful read when the read gate's setting cannot be read", async () => {
		// `booleanSetting` is a bare `prisma.setting.findMany` and it runs inside the wrapper's own
		// `try`. Unguarded, a settings read that threw would be caught there and turn a request that
		// had already succeeded into a 500 — which is the one thing the logging path must never do to
		// a caller. Test 7 cannot reach this: it uses a command, where the gate short-circuits on the
		// outcome before `booleanSetting` is called at all.
		const settings = vi.spyOn(prisma.setting, "findMany").mockRejectedValueOnce(new Error("database is locked"));

		try {
			const route = apiRoute(JOBS, async () => ({
				response: Response.json({ jobs: [], nextCursor: null }),
				message: "Listed 0 jobs",
			}));

			const response = await route(jobsRequest());

			expect(response.status).toBe(200);
			// Proves the injected failure was reached rather than the guard never being exercised.
			expect(settings).toHaveBeenCalled();
			// And it fails toward the record: suppression is the branch that throws information away,
			// so it must not be what an unreadable rule defaults to.
			const rows = await lines();
			expect(rows).toHaveLength(1);
			expect(rows[0].level).toBe("INFO");
		} finally {
			settings.mockRestore();
		}
	});

	it("returns 202 when the log write fails", async () => {
		// The write is stubbed to reject rather than the test merely asserting that nothing threw: a
		// version that only checked for the absence of a throw would pass with the logging removed
		// entirely, which is the one regression this test exists to catch.
		const create = vi.spyOn(logsDb.logEntry, "create").mockRejectedValueOnce(new Error("no space left on device"));

		try {
			const route = apiRoute<PrintParams>(PRINT, async () => ({
				response: Response.json({ jobId: "j1", status: "QUEUED", lines: 24 }, { status: 202 }),
				message: "Printed 24 lines to 'kitchen'",
			}));

			const response = await route(...printCall());

			expect(response.status).toBe(202);
			expect(await response.json()).toMatchObject({ jobId: "j1", status: "QUEUED" });
			// Proves the injected failure was reached. Without it the assertions above hold for a
			// wrapper that never attempted a write.
			expect(create).toHaveBeenCalledTimes(1);
			expect(await lines()).toHaveLength(0);
		} finally {
			create.mockRestore();
		}
	});

	it("refuses to build a route for an id the registry does not declare", async () => {
		// A typo has to be a build failure rather than a route that quietly logs nothing: `apiRoute`
		// is called at module load, so this throws while the route file is being imported.
		expect(() => apiRoute("api:GET /v1/jbos", async () => ({ response: new Response(), message: "" }))).toThrow(
			/api:GET \/v1\/jbos/,
		);
	});
});
