import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Page views, and the setting that decides whether there are any.
 *
 * Off by default, and that is the case worth pinning: `router.refresh()` re-runs a route's server
 * component, so on a live tab this runs at event rate rather than at navigation rate.
 *
 * Mocked and dynamically imported for the same reason `permission-matrix.test.ts` is: `requestProvenance`
 * reaches `next/headers` and `@/lib/request-context`, and the session has to be steerable per case.
 */
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/request-context", () => ({
	getClientAddress: async () => "203.0.113.50",
	getUserAgent: async () => "vitest",
}));

const currentSessionUser = vi.fn();
vi.mock("@/lib/auth/require-session", () => ({ requireSession: async () => currentSessionUser() }));

const { PAGE_VIEW_ACTION } = await import("@/lib/audit/system-actions");
const { requirePagePermission } = await import("@/lib/auth/require-permission");
const { auditDb, prisma } = await import("@/lib/db");
const { setSetting } = await import("@/lib/settings/settings-service");

/**
 * A fresh account with an id no earlier case has used.
 *
 * `effectivePermissions` memoises per id through React's `cache`, and outside a request that memo
 * lives for the whole process — so a reused id reads the first case's answer.
 *
 * @param id the account id, unique within this file
 * @param permissions what to grant it
 * @returns the account, already installed as the current session
 */
async function grantedAccount(id: string, ...permissions: string[]) {
	await prisma.user.create({ data: { id, name: id, email: `${id}@example.com` } });
	for (const permission of permissions) {
		await prisma.userPermission.create({ data: { userId: id, permission } });
	}
	const user = { id, name: id, email: `${id}@example.com`, isSuperuser: false, mustChangePassword: false };
	currentSessionUser.mockResolvedValue(user);
	return user;
}

describe("page view recording", () => {
	beforeEach(async () => {
		await auditDb.auditEvent.deleteMany({});
		await auditDb.auditAnchor.deleteMany({});
		await auditDb.auditEpoch.deleteMany({});
		await prisma.setting.deleteMany({});
		await prisma.userPermission.deleteMany({});
		await prisma.user.deleteMany({});
		currentSessionUser.mockReset();
	});

	it("records nothing while the setting is off", async () => {
		const user = await grantedAccount("pv1", "dashboard:read");

		await requirePagePermission("dashboard:read", "/dashboard");

		expect(await auditDb.auditEvent.count()).toBe(0);
		expect(user.id).toBe("pv1");
	});

	it("records the route when the setting is on", async () => {
		await setSetting("audit.recordPageViews", true);
		await grantedAccount("pv2", "jobs:read");

		await requirePagePermission("jobs:read", "/jobs");

		const row = await auditDb.auditEvent.findFirstOrThrow();
		expect(row.action).toBe(PAGE_VIEW_ACTION);
		expect(row.outcome).toBe("SUCCESS");
		expect(row.targetKind).toBe("page");
		expect(row.targetId).toBe("/jobs");
	});

	it("names the account that opened it", async () => {
		await setSetting("audit.recordPageViews", true);
		await grantedAccount("pv4", "logs:read");

		await requirePagePermission("logs:read", "/logs");

		const row = await auditDb.auditEvent.findFirstOrThrow();
		expect(row.actorKind).toBe("USER");
		expect(row.actorUserId).toBe("pv4");
	});

	it("records nothing for a caller it refused", async () => {
		await setSetting("audit.recordPageViews", true);
		await grantedAccount("pv3");

		// `redirect` signals by throwing, which is what a refusal does here.
		await expect(requirePagePermission("jobs:read", "/jobs")).rejects.toThrow();

		// A refused page view is a redirect to `/no-access`, not a view. The refusal itself is not
		// recorded either: a page is not an action, nothing happened, and `/no-access` is reachable by
		// anyone signed in — recording every arrival at it would be recording navigation, not probing.
		expect(await auditDb.auditEvent.count()).toBe(0);
	});
});
