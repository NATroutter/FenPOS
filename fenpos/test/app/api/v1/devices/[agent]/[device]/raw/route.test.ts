import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashSecret } from "@/lib/auth/secrets";
import { logsDb, prisma } from "@/lib/db";
import { MAX_NAME_LENGTH } from "@/lib/domain/naming";
import { ApiError } from "@/lib/errors";
import { setSetting } from "@/lib/settings/settings-service";

/**
 * `POST /api/v1/devices/{agent}/{device}/raw` — arbitrary bytes to a printer.
 *
 * This is the one endpoint in the system whose effect this server cannot describe afterwards: the
 * bytes go to the hardware unread, so nothing here knows what was printed. Three things follow, and
 * this file tests all three: the double gate (a permission *and* an install setting), the ordering
 * that keeps a disabled install from leaking which devices exist, and the audit row, which is the
 * only record that a write ever happened.
 */
vi.mock("@/lib/link/commands", () => ({ sendRawWrite: vi.fn(async () => "wrote 12 bytes") }));

const { POST } = await import("@/app/api/v1/devices/[agent]/[device]/raw/route");
const { sendRawWrite } = await import("@/lib/link/commands");

const BYTES = Buffer.from([0x1b, 0x40, 0x48, 0x65, 0x6c, 0x6c, 0x6f]).toString("base64");

let token: string;
let agentName: string;
let keyId: string;

/**
 * @param body the JSON body to post
 * @param device the device name in the path
 * @returns the arguments to spread into `POST`
 */
function call(body: unknown, device = "kitchen"): [Request, { params: Promise<{ agent: string; device: string }> }] {
	return [
		new Request(`https://fenpos.test/api/v1/devices/${agentName}/${device}/raw`, {
			method: "POST",
			headers: { authorization: `Bearer ${token}` },
			body: JSON.stringify(body),
		}),
		{ params: Promise.resolve({ agent: agentName, device }) },
	];
}

beforeEach(async () => {
	vi.mocked(sendRawWrite).mockClear();

	await logsDb.logEntry.deleteMany();
	await prisma.apiKeyDevice.deleteMany();
	await prisma.apiKeyPermission.deleteMany();
	await prisma.apiKey.deleteMany();
	await prisma.device.deleteMany();
	await prisma.agent.deleteMany();
	await prisma.setting.deleteMany();

	const agent = await prisma.agent.create({ data: { name: `helsinki-${Date.now()}` } });
	agentName = agent.name;
	const kitchen = await prisma.device.create({
		data: { agentId: agent.id, name: "kitchen", port: "COM3", columns: 42 },
	});
	await prisma.device.create({ data: { agentId: agent.id, name: "bar", port: "COM4", columns: 32 } });

	token = `fp_${Date.now()}_${Math.random()}`;
	const key = await prisma.apiKey.create({
		data: {
			name: "label-printer integration",
			keyHash: hashSecret(token),
			maskedHint: "abcd",
			permissions: { create: [{ permission: "devices:raw" }] },
			devices: { create: [{ deviceId: kitchen.id }] },
		},
	});
	keyId = key.id;

	// Every case below that expects a write to reach the printer needs this; the ones about the gate
	// switch it back off themselves.
	await setSetting("link.allowRawApiWrites", true);
});

describe("POST /api/v1/devices/{agent}/{device}/raw", () => {
	it("sends the decoded bytes to the printer", async () => {
		const response = await POST(...call({ bytes: BYTES }));

		expect(response.status).toBe(200);
		expect(vi.mocked(sendRawWrite)).toHaveBeenCalledWith(expect.any(String), "kitchen", BYTES);
	});

	it("passes the agent's own message through, because only it knows what happened", async () => {
		const body = await (await POST(...call({ bytes: BYTES }))).json();

		expect(body.message).toBe("wrote 12 bytes");
	});

	it("refuses every caller while the install has raw writes off", async () => {
		await setSetting("link.allowRawApiWrites", false);

		const response = await POST(...call({ bytes: BYTES }));

		expect(response.status).toBe(403);
		expect((await response.json()).error).toBe("raw_writes_disabled");
		expect(vi.mocked(sendRawWrite)).not.toHaveBeenCalled();
	});

	it("answers the same way for a granted and an ungranted device while it is off", async () => {
		// The ordering test. With the setting off, the response must not depend on which devices the
		// key holds — otherwise an install that has switched raw writes off still answers the question
		// "does this printer exist" for anyone holding the permission.
		await setSetting("link.allowRawApiWrites", false);

		const granted = await POST(...call({ bytes: BYTES }, "kitchen"));
		const ungranted = await POST(...call({ bytes: BYTES }, "bar"));
		const absent = await POST(...call({ bytes: BYTES }, "nowhere"));

		// One read each. A response body is a stream, so reading the middle one twice fails on the
		// second read whatever the route did — which says nothing about the ordering under test.
		const [grantedBody, ungrantedBody, absentBody] = await Promise.all([
			granted.json(),
			ungranted.json(),
			absent.json(),
		]);

		// The status is half the answer: a 403 and a 404 carrying the same body would still tell a
		// caller which of the three names exists.
		expect([granted.status, ungranted.status, absent.status]).toEqual([403, 403, 403]);
		expect(grantedBody).toEqual(ungrantedBody);
		expect(ungrantedBody).toEqual(absentBody);
	});

	it("refuses a key without the permission, even while the install allows raw writes", async () => {
		await prisma.apiKeyPermission.deleteMany({ where: { apiKeyId: keyId } });

		const response = await POST(...call({ bytes: BYTES }));

		expect(response.status).toBe(403);
		expect((await response.json()).error).toBe("insufficient_permission");
		expect(vi.mocked(sendRawWrite)).not.toHaveBeenCalled();
	});

	it("reports an ungranted device as unknown once the install allows raw writes", async () => {
		const response = await POST(...call({ bytes: BYTES }, "bar"));

		expect(response.status).toBe(404);
		expect((await response.json()).error).toBe("unknown_device");
		expect(vi.mocked(sendRawWrite)).not.toHaveBeenCalled();
	});

	it("refuses a payload over the configured cap", async () => {
		await setSetting("link.maxRawWriteBytes", 4);

		const response = await POST(...call({ bytes: BYTES }));

		expect(response.status).toBe(413);
		expect((await response.json()).error).toBe("body_too_large");
		expect(vi.mocked(sendRawWrite)).not.toHaveBeenCalled();
	});

	it("refuses a 'bytes' that is not base64", async () => {
		const response = await POST(...call({ bytes: "not base64!!" }));

		expect(response.status).toBe(400);
		expect((await response.json()).error).toBe("invalid_type");
		expect(vi.mocked(sendRawWrite)).not.toHaveBeenCalled();
	});

	it("refuses a body with no bytes at all", async () => {
		const response = await POST(...call({}));

		expect(response.status).toBe(400);
		expect((await response.json()).error).toBe("missing_field");
	});

	it("records an audit line naming the key and the size", async () => {
		await POST(...call({ bytes: BYTES }));

		const rows = await logsDb.logEntry.findMany();
		expect(rows).toHaveLength(1);
		expect(rows[0].level).toBe("INFO");
		expect(rows[0].message).toContain("label-printer integration");
		// The whole phrase, not a bare "7". A single digit matches anywhere in the line — a digit
		// inside a name, another number — so it would pass on a row that never mentioned the size at all.
		expect(rows[0].message).toContain("Raw write of 7 bytes");
	});

	it("attributes the audit row to the agent and device by name, not only by id", async () => {
		// The names are what let the row outlive the agent or device being deleted later —
		// `LogEntry.agentName`/`deviceName` exist for exactly that, and this route is their
		// motivating case: the audit row is the only record a raw write ever happened.
		await POST(...call({ bytes: BYTES }));

		const rows = await logsDb.logEntry.findMany();
		expect(rows).toHaveLength(1);
		expect(rows[0].agentName).toBe(agentName);
		expect(rows[0].deviceName).toBe("kitchen");
	});

	it("does not invent an agent's name when nothing on the request identifies one", async () => {
		// The path segment is the caller's claim, not a fact. Before this line is attributed by name,
		// something must have actually matched it against a real agent — otherwise a request naming
		// an agent that does not exist would store that invented name as if it were real.
		await POST(
			new Request(`https://fenpos.test/api/v1/devices/no-such-agent/kitchen/raw`, {
				method: "POST",
				headers: { authorization: `Bearer ${token}` },
				body: JSON.stringify({ bytes: BYTES }),
			}),
			{ params: Promise.resolve({ agent: "no-such-agent", device: "kitchen" }) },
		);

		const rows = await logsDb.logEntry.findMany();
		expect(rows).toHaveLength(1);
		expect(rows[0].agentName).toBeNull();
	});

	it("does not call a timed-out write a refusal, because nobody here knows what the printer did", async () => {
		// The wording is the test. `sendRawWrite` times out with "the bytes may or may not have been
		// written" — the honest answer — and an audit trail that recorded that as "refused" would tell
		// an operator the paper is clean when it may not be. The paper is the only place they can
		// check, so this line must not answer the question it cannot answer.
		vi.mocked(sendRawWrite).mockRejectedValueOnce(
			new ApiError("agent_offline", "The agent did not answer; the bytes may or may not have been written."),
		);

		const response = await POST(...call({ bytes: BYTES }));

		expect(response.status).toBe(503);

		// Two rows for one write: the INFO recorded before the send, and this. The send happened.
		const rows = await logsDb.logEntry.findMany({ orderBy: { ts: "asc" } });
		expect(rows).toHaveLength(2);
		expect(rows[1].level).toBe("WARN");
		expect(rows[1].message).not.toContain("refused");
		expect(rows[1].message).toContain("did not complete");
		expect(rows[1].message).toContain("may or may not have been written");
	});

	it("keeps the outcome readable when logs.maxMessageChars sits at its floor with maximum-length names", async () => {
		// `logs.maxMessageChars` cannot go below 200, and MAX_NAME_LENGTH lets a device name and a key
		// name each run to 64 characters — the worst case this route can be handed. Between them the
		// two names alone eat most of a 200-character budget, so what has to survive truncation is the
		// one sentence this row exists to carry: whether the bytes may or may not have reached the
		// printer. If that gets truncated away and only the names and boilerplate remain, the audit
		// trail has failed at the only thing it is for.
		await setSetting("logs.maxMessageChars", 200);

		const longDeviceName = "d".repeat(MAX_NAME_LENGTH);
		const longKeyName = "k".repeat(MAX_NAME_LENGTH);
		const longToken = `fp_long_${Date.now()}_${Math.random()}`;

		const agent = await prisma.agent.findUniqueOrThrow({ where: { name: agentName } });
		const longDevice = await prisma.device.create({
			data: { agentId: agent.id, name: longDeviceName, port: "COM5", columns: 42 },
		});
		await prisma.apiKey.create({
			data: {
				name: longKeyName,
				keyHash: hashSecret(longToken),
				maskedHint: "wxyz",
				permissions: { create: [{ permission: "devices:raw" }] },
				devices: { create: [{ deviceId: longDevice.id }] },
			},
		});

		vi.mocked(sendRawWrite).mockRejectedValueOnce(
			new ApiError("agent_offline", "The agent did not answer; the bytes may or may not have been written."),
		);

		const response = await POST(
			new Request(`https://fenpos.test/api/v1/devices/${agentName}/${longDeviceName}/raw`, {
				method: "POST",
				headers: { authorization: `Bearer ${longToken}` },
				body: JSON.stringify({ bytes: BYTES }),
			}),
			{ params: Promise.resolve({ agent: agentName, device: longDeviceName }) },
		);

		expect(response.status).toBe(503);

		const rows = await logsDb.logEntry.findMany({ orderBy: { ts: "asc" } });
		const warnRow = rows.find((row) => row.level === "WARN");
		expect(warnRow?.message.length).toBeLessThanOrEqual(200);
		expect(warnRow?.message).toContain("may or may not have been written");
	});

	it("says plainly that nothing was sent when the write never reached the agent", async () => {
		// The other half of the pair. A refusal before the send *can* answer the question, and an
		// operator reading the Logs tab should not have to guess which kind of failure they are looking
		// at.
		await setSetting("link.allowRawApiWrites", false);

		await POST(...call({ bytes: BYTES }));

		const rows = await logsDb.logEntry.findMany();
		expect(rows[0].message).toContain("refused");
		expect(rows[0].message).toContain("Nothing was sent.");
	});

	it("records an audit line for an unexpected fault, not only for a refusal it anticipated", async () => {
		// A fault the route did not plan for is exactly the one an operator most needs to see, and it
		// is answered as `internal_error` with the details deliberately kept out of the response — so
		// the audit row is the only place the caller's own name is attached to it.
		vi.mocked(sendRawWrite).mockRejectedValueOnce(new Error("the link registry exploded"));

		const response = await POST(...call({ bytes: BYTES }));

		expect(response.status).toBe(500);

		const rows = await logsDb.logEntry.findMany({ orderBy: { ts: "asc" } });
		expect(rows).toHaveLength(2);
		expect(rows[1].level).toBe("WARN");
		expect(rows[1].message).toContain("internal_error");
		expect(rows[1].message).toContain("label-printer integration");
	});

	it("bounds the device name it writes into an audit line", async () => {
		// The path segment is the caller's, and on the pre-grant path nothing has validated it. A real
		// device name cannot exceed MAX_NAME_LENGTH, so truncating there loses nothing an operator
		// could have wanted while keeping an invented segment from writing an unbounded string into a
		// row this server stores verbatim.
		await setSetting("link.allowRawApiWrites", false);

		await POST(...call({ bytes: BYTES }, "d".repeat(5_000)));

		const rows = await logsDb.logEntry.findMany();
		expect(rows).toHaveLength(1);
		expect(rows[0].message).toContain(`'${"d".repeat(MAX_NAME_LENGTH)}'`);
		expect(rows[0].message.length).toBeLessThan(MAX_NAME_LENGTH + 200);
	});

	it("records an audit line when a write is refused for a reason other than a bad credential", async () => {
		await setSetting("link.allowRawApiWrites", false);

		await POST(...call({ bytes: BYTES }));

		const rows = await logsDb.logEntry.findMany();
		expect(rows).toHaveLength(1);
		expect(rows[0].level).toBe("WARN");
	});

	it("records nothing for a caller who never identified themselves", async () => {
		// Nothing to attribute the line to, and an unauthenticated endpoint that writes a database row
		// per request is a way to fill a disk.
		await POST(
			new Request(`https://fenpos.test/api/v1/devices/${agentName}/kitchen/raw`, {
				method: "POST",
				body: JSON.stringify({ bytes: BYTES }),
			}),
			{ params: Promise.resolve({ agent: agentName, device: "kitchen" }) },
		);

		expect(await logsDb.logEntry.count()).toBe(0);
	});
});
