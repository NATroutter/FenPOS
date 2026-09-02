import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Jobs tab's infinite scroll action.
 *
 * `cancelJob` is already covered by `permission-matrix.test.ts` (it is a plain `command`) and needs
 * nothing further here. `listMoreJobs` is a `query` with its own request shape to validate, which the
 * matrix cannot see — what is worth pinning down is that it re-checks `jobs:read` for itself, that it
 * narrows exactly as `listJobs` would from the page's own `searchParams`, and that a hostile offset or
 * filter value cannot reach `listJobs` unclamped.
 */
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/request-context", () => ({
	getClientAddress: async () => "203.0.113.50",
	getUserAgent: async () => "vitest",
}));

const currentSessionUser = vi.fn();
vi.mock("@/lib/auth/require-session", () => ({
	requireSession: async () => currentSessionUser(),
	currentSessionId: async (fallback: string) => fallback,
}));

const { listMoreJobs } = await import("@/app/(panel)/jobs/actions");
const { auditDb, prisma } = await import("@/lib/db");

let nextAccount = 0;

/** A fresh account, with an id no earlier case has used — `effectivePermissions` memoises per id. */
async function account(permissions: string[], isSuperuser = false) {
	nextAccount += 1;
	const id = `jobs-action-${nextAccount}`;
	await prisma.user.create({ data: { id, name: id, email: `${id}@example.com`, isSuperuser } });
	for (const permission of permissions) {
		await prisma.userPermission.create({ data: { userId: id, permission } });
	}
	const user = { id, name: id, email: `${id}@example.com`, isSuperuser, mustChangePassword: false };
	currentSessionUser.mockResolvedValue(user);
	return user;
}

async function seedJobs(agentId: string, deviceId: string, count: number): Promise<void> {
	await prisma.job.createMany({
		data: Array.from({ length: count }, (_, index) => ({
			agentId,
			deviceId,
			status: "COMPLETED" as const,
			submittedAt: new Date(Date.now() + index),
		})),
	});
}

beforeEach(async () => {
	await auditDb.auditEvent.deleteMany({});
	await prisma.job.deleteMany({});
	await prisma.device.deleteMany({});
	await prisma.agent.deleteMany({});
	await prisma.userPermission.deleteMany({});
	await prisma.session.deleteMany({});
	await prisma.account.deleteMany({});
	await prisma.user.deleteMany({});
	currentSessionUser.mockReset();
});

describe("listMoreJobs", () => {
	it("refuses a caller without jobs:read, and records the refusal", async () => {
		await account([]);

		const batch = await listMoreJobs({ offset: 0 });

		expect(batch.jobs).toEqual([]);
		expect(batch.more).toBe(false);
		expect(batch.error).toContain("permission");
		const row = await auditDb.auditEvent.findFirstOrThrow({ orderBy: { seq: "desc" } });
		expect(row.action).toBe("jobs:list-more");
		expect(row.outcome).toBe("DENIED");
	});

	it("returns the batch starting at the given offset", async () => {
		await account(["jobs:read"]);
		const agent = await prisma.agent.create({ data: { name: "site-a" } });
		const device = await prisma.device.create({ data: { agentId: agent.id, name: "kitchen", port: "COM3" } });
		await seedJobs(agent.id, device.id, 5);

		const first = await listMoreJobs({ offset: 0 });
		expect(first.jobs).toHaveLength(5);
		expect(first.more).toBe(false);
		expect(first.error).toBeNull();

		const second = await listMoreJobs({ offset: first.jobs.length });
		// Nothing left past the only page there is — goes red if `skip` is dropped rather than clamped
		// and applied, which would return the same five jobs again.
		expect(second.jobs).toEqual([]);
	});

	it("narrows by the same statuses the page's dropdown would send", async () => {
		await account(["jobs:read"]);
		const agent = await prisma.agent.create({ data: { name: "site-a" } });
		const device = await prisma.device.create({ data: { agentId: agent.id, name: "kitchen", port: "COM3" } });
		await prisma.job.createMany({
			data: [
				{ agentId: agent.id, deviceId: device.id, status: "COMPLETED" },
				{ agentId: agent.id, deviceId: device.id, status: "FAILED" },
				{ agentId: agent.id, deviceId: device.id, status: "CANCELLED" },
			],
		});

		// The tab's dropdowns are multi-select and send several values in one comma-joined parameter.
		const batch = await listMoreJobs({ offset: 0, status: "FAILED,CANCELLED" });

		expect(batch.jobs.map((job) => job.status).sort()).toEqual(["CANCELLED", "FAILED"]);
	});

	it("clamps a hostile offset rather than handing it to the database unclamped", async () => {
		await account(["jobs:read"]);
		const agent = await prisma.agent.create({ data: { name: "site-a" } });
		const device = await prisma.device.create({ data: { agentId: agent.id, name: "kitchen", port: "COM3" } });
		await seedJobs(agent.id, device.id, 3);

		// What a hostile client can actually post: `offset` is typed `unknown` for exactly this.
		const batch = await listMoreJobs({ offset: -5 });

		expect(batch.error).toBeNull();
		expect(batch.jobs).toHaveLength(3);
	});

	it("drops a status this system does not use rather than erroring", async () => {
		await account(["jobs:read"]);
		const agent = await prisma.agent.create({ data: { name: "site-a" } });
		const device = await prisma.device.create({ data: { agentId: agent.id, name: "kitchen", port: "COM3" } });
		await seedJobs(agent.id, device.id, 2);

		const batch = await listMoreJobs({ offset: 0, status: "NOT_A_STATUS" });

		// A dropped filter reads as "no filter", not as an error — the same reading the page's own
		// `parseKnownValues` takes for a stale bookmark.
		expect(batch.error).toBeNull();
		expect(batch.jobs).toHaveLength(2);
	});

	it("does not record a success, so a scroll does not bury the tab's one recorded action", async () => {
		await account(["jobs:read"]);

		await listMoreJobs({ offset: 0 });

		expect(await auditDb.auditEvent.count()).toBe(0);
	});

	it("allows a superuser holding no row at all", async () => {
		await account([], true);
		const agent = await prisma.agent.create({ data: { name: "site-a" } });
		const device = await prisma.device.create({ data: { agentId: agent.id, name: "kitchen", port: "COM3" } });
		await seedJobs(agent.id, device.id, 1);

		const batch = await listMoreJobs({ offset: 0 });

		expect(batch.error).toBeNull();
		expect(batch.jobs).toHaveLength(1);
	});
});
