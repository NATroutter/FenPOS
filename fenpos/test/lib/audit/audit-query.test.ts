import { beforeEach, describe, expect, it } from "vitest";
import { apiKeyActor, appendEvent, SYSTEM_ACTOR, userActor } from "@/lib/audit/audit-log";
import { auditFilterOptions, KNOWN_AUDIT_ACTIONS, listAuditEvents } from "@/lib/audit/audit-query";
import { auditDb, prisma } from "@/lib/db";

/**
 * The read half of the record.
 *
 * Written through `appendEvent` rather than by inserting rows directly, so the fixtures are chained
 * exactly as production rows are — a filter that only works on hand-built rows is a filter that works
 * on nothing real.
 */
describe("listAuditEvents", () => {
	beforeEach(async () => {
		await auditDb.auditEvent.deleteMany({});
		await auditDb.auditAnchor.deleteMany({});
		await auditDb.auditEpoch.deleteMany({});

		await appendEvent({
			action: "devices:delete",
			outcome: "SUCCESS",
			actor: userActor({ id: "q-ada", name: "Ada", email: "ada@example.com" }),
			target: { kind: "device", id: "d1", label: "Kitchen" },
			detail: { port: "COM3" },
		});
		await appendEvent({
			action: "keys:create",
			outcome: "DENIED",
			actor: userActor({ id: "q-sam", name: "Sam", email: "sam@example.com" }),
		});
		await appendEvent({
			action: "jobs:read",
			outcome: "FAILURE",
			actor: apiKeyActor({ id: "k1", name: "Till 4" }),
		});
		await appendEvent({ action: "audit:sweep", outcome: "SUCCESS", actor: SYSTEM_ACTOR });
	});

	it("lists newest first", async () => {
		const page = await listAuditEvents();

		expect(page.events.map((event) => event.action)).toEqual([
			"audit:sweep",
			"jobs:read",
			"keys:create",
			"devices:delete",
		]);
	});

	it("names the actor whatever kind it is", async () => {
		const page = await listAuditEvents();
		const byAction = new Map(page.events.map((event) => [event.action, event]));

		expect(byAction.get("devices:delete")?.actor).toBe("Ada");
		expect(byAction.get("jobs:read")?.actor).toBe("Till 4");
		expect(byAction.get("audit:sweep")?.actor).toBe("System");
	});

	it("narrows to one actor", async () => {
		const page = await listAuditEvents({ actorUserId: "q-ada" });

		expect(page.events).toHaveLength(1);
		expect(page.events[0].action).toBe("devices:delete");
	});

	it("narrows to one action", async () => {
		const page = await listAuditEvents({ action: "keys:create" });

		expect(page.events).toHaveLength(1);
		expect(page.events[0].outcome).toBe("DENIED");
	});

	it("narrows to one outcome", async () => {
		const page = await listAuditEvents({ outcome: "FAILURE" });

		expect(page.events).toHaveLength(1);
		expect(page.events[0].action).toBe("jobs:read");
	});

	it("narrows to one target", async () => {
		const page = await listAuditEvents({ targetId: "d1" });

		expect(page.events).toHaveLength(1);
		expect(page.events[0].targetLabel).toBe("Kitchen");
	});

	it("narrows to a date range", async () => {
		const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);

		expect((await listAuditEvents({ from: tomorrow })).events).toHaveLength(0);
		expect((await listAuditEvents({ to: tomorrow })).events).toHaveLength(4);
	});

	it("says whether more follow", async () => {
		const page = await listAuditEvents({ take: 2 });

		expect(page.events).toHaveLength(2);
		expect(page.more).toBe(true);
	});

	it("says when no more follow", async () => {
		const page = await listAuditEvents({ take: 50 });

		expect(page.more).toBe(false);
	});

	it("keeps the detail as stored, so the pane can render the JSON", async () => {
		const page = await listAuditEvents({ action: "devices:delete" });

		expect(page.events[0].detail).toContain("COM3");
	});

	it("uses the default ordering when the caller names none", async () => {
		// Not a test that an *unknown* column falls back — `AuditSortColumn` makes one unrepresentable
		// here, and `isAuditSortColumn` is what turns a stale bookmark into `undefined` before it ever
		// reaches this. This pins the other half: that `undefined` means newest first.
		const page = await listAuditEvents({ sort: undefined, desc: undefined });

		expect(page.events[0].action).toBe("audit:sweep");
	});

	it("orders by a column the caller does name", async () => {
		const page = await listAuditEvents({ sort: "action", desc: false });

		expect(page.events.map((event) => event.action)).toEqual([
			"audit:sweep",
			"devices:delete",
			"jobs:read",
			"keys:create",
		]);
	});
});

describe("auditFilterOptions", () => {
	beforeEach(async () => {
		await auditDb.auditEvent.deleteMany({});
		await auditDb.auditAnchor.deleteMany({});
		await auditDb.auditEpoch.deleteMany({});
		await appendEvent({
			action: "devices:delete",
			outcome: "SUCCESS",
			actor: userActor({ id: "o-ada", name: "Ada", email: "ada@example.com" }),
		});
	});

	it("offers the actors the record actually holds", async () => {
		const options = await auditFilterOptions();

		expect(options.actors).toEqual([{ id: "o-ada", label: "Ada" }]);
	});

	it("offers an actor whose account no longer exists", async () => {
		// The case the whole thing is for: `actorUserId` is a plain column in another database file,
		// not a relation, so a deleted account keeps its trail — and is usually who somebody is
		// looking for. The `prisma.user` lookup below is what makes that concrete: the id names no
		// account and the option is offered anyway.
		await appendEvent({
			action: "users:delete",
			outcome: "SUCCESS",
			actor: userActor({ id: "o-gone", name: "Departed", email: "gone@example.com" }),
		});

		const options = await auditFilterOptions();

		expect(options.actors.map((actor) => actor.id)).toContain("o-gone");
		expect(await prisma.user.findUnique({ where: { id: "o-gone" } })).toBeNull();
	});

	it("offers every action a row could carry, not only the ones present", async () => {
		const options = await auditFilterOptions();

		// Built from the declaring modules rather than from a DISTINCT: an action nobody has taken yet
		// is exactly the one somebody wants to filter for, and it is absent from the table precisely
		// because it has not happened.
		expect(options.actions).toContain("devices:delete");
		expect(options.actions).toContain("users:delete");
		expect(options.actions).toContain("auth:sign-in");
		expect(options.actions).toContain("audit:sweep");
		expect(options.actions).toContain("page:view");
	});
});

describe("KNOWN_AUDIT_ACTIONS", () => {
	it("has no duplicates", () => {
		expect(new Set(KNOWN_AUDIT_ACTIONS).size).toBe(KNOWN_AUDIT_ACTIONS.length);
	});

	it("is sorted, so the filter's list does not depend on declaration order", () => {
		expect([...KNOWN_AUDIT_ACTIONS]).toEqual([...KNOWN_AUDIT_ACTIONS].sort());
	});
});
