import { afterEach, describe, expect, it, vi } from "vitest";
import type { PanelUser } from "@/lib/auth/require-session";

/**
 * `currentUser` is stubbed the way `test/app/api/events/route.test.ts` stubs it: the mock spreads
 * the real module via `importActual` and overrides only `currentUser`, referenced through a wrapper
 * closure rather than captured directly, so the outer `const` below is not read before its own
 * initialiser runs. Nothing else this route touches — `readAvatar`, `setAvatar` — comes from
 * `@/lib/auth/require-session`, so nothing else needed the real exports.
 *
 * **The spread is now load-bearing rather than merely conventional.** `sessionVerdict` comes from
 * this same module and the route calls it, so it is the *real* one here — running the real gates
 * against the real database, the way the events suite runs them. A gate this route stops applying is
 * a failure in this file rather than a hole nobody notices.
 */
const currentUser = vi.fn<() => Promise<PanelUser | null>>();
vi.mock("@/lib/auth/require-session", async (importActual) => ({
	...(await importActual<typeof import("@/lib/auth/require-session")>()),
	currentUser: () => currentUser(),
}));

// `sessionVerdict`'s allowlist gate reads the caller's address, and `next/headers` raises outside a
// live request. A fixed address stands in, so the allowlist test below turns on what is configured
// rather than on what the runtime could see. Same stand-in as `test/app/api/events/route.test.ts`.
vi.mock("@/lib/request-context", () => ({
	getClientAddress: async () => "203.0.113.30",
	getUserAgent: async () => "vitest",
}));

import { GET } from "@/app/api/avatar/[userId]/route";
import { readAvatar, setAvatar } from "@/lib/auth/avatar-service";
import { prisma } from "@/lib/db";
import { setSetting } from "@/lib/settings/settings-service";
import { makeUser } from "@/test/helpers/accounts";
import { pngOf } from "@/test/helpers/images";

const request = new Request("http://localhost/api/avatar/x");

// Settings are per-file state here, and only one test sets any: cleared afterwards so an allowlist
// left behind cannot decide the outcome of whichever test happens to run next.
afterEach(async () => {
	await prisma.setting.deleteMany();
});

describe("GET /api/avatar/[userId]", () => {
	it("refuses anyone not signed in", async () => {
		currentUser.mockResolvedValue(null);
		const user = await makeUser();

		expect((await GET(request, { params: Promise.resolve({ userId: user.id }) })).status).toBe(401);
	});

	/**
	 * The gap this route had: `currentUser` resolves the session cookie and applies none of the
	 * gates — the IP allowlist, the inactivity timeout, the forced password change, the two-factor
	 * enrolment gate. A session from an address since removed from `auth.ipAllowlist` still holds a
	 * cookie that resolves, and before `sessionVerdict` was called here it could enumerate every
	 * operator's picture while being refused every page that lists them.
	 *
	 * The allowlist stands in for all of them: the point is that the verdict is consulted at all, and
	 * `sessionVerdict` is where a gate added later reaches this caller without anything being
	 * repeated here by hand.
	 */
	it("refuses a signed-in session whose verdict is not 'allowed'", async () => {
		const user = await makeUser();
		await setAvatar(user.id, await pngOf(90, 90), { x: 0, y: 0, size: 90 });
		currentUser.mockResolvedValue(user);
		// The mocked address is 203.0.113.30, which this range does not contain.
		await setSetting("auth.ipAllowlist", "10.0.0.0/8");

		expect((await GET(request, { params: Promise.resolve({ userId: user.id }) })).status).toBe(401);
	});

	it("serves the stored render to a signed-in caller", async () => {
		const user = await makeUser();
		await setAvatar(user.id, await pngOf(90, 90), { x: 0, y: 0, size: 90 });
		currentUser.mockResolvedValue(user);

		const response = await GET(request, { params: Promise.resolve({ userId: user.id }) });
		const stored = await readAvatar(user.id);
		if (stored === null) {
			throw new Error("expected setAvatar to have stored a row");
		}

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("image/png");
		const body = Buffer.from(await response.arrayBuffer());
		// Byte-for-byte against the row `readAvatar` reads, not merely "some non-empty body": a route
		// that served a placeholder or another account's picture would still pass a length check.
		expect(body.equals(stored.bytes)).toBe(true);
	});

	it("answers 404 for an account with no avatar, so the fallback initial draws", async () => {
		const user = await makeUser();
		currentUser.mockResolvedValue(user);

		expect((await GET(request, { params: Promise.resolve({ userId: user.id }) })).status).toBe(404);
	});

	it("never lets a shared cache keep one account's picture, and pins the ETag to the row's own updatedAt", async () => {
		const user = await makeUser();
		await setAvatar(user.id, await pngOf(90, 90), { x: 0, y: 0, size: 90 });
		currentUser.mockResolvedValue(user);

		const response = await GET(request, { params: Promise.resolve({ userId: user.id }) });
		const stored = await readAvatar(user.id);
		if (stored === null) {
			throw new Error("expected setAvatar to have stored a row");
		}

		expect(response.headers.get("cache-control")).toContain("private");
		// The ETag is what makes a re-crop visible immediately rather than after a shared cache's
		// arbitrary max-age, so it must be pinned to the exact value the route derives it from.
		expect(response.headers.get("etag")).toBe(`"${stored.updatedAt.getTime()}"`);
	});

	/**
	 * The other half of that ETag, and the half that was missing: `no-cache, must-revalidate` has the
	 * browser ask again on every render, so without this the route answered every one of those asks
	 * with the whole picture — `/users` on a fifty-operator install re-downloading fifty renders per
	 * page load to be told nothing had changed.
	 *
	 * The headers are asserted on the 304 too. A revalidation that answered bare would leave the
	 * browser's stored copy with no freshness information for the next render, and the round trip
	 * would repeat as a 200.
	 */
	it("answers 304 to a caller that already holds this render", async () => {
		const user = await makeUser();
		await setAvatar(user.id, await pngOf(90, 90), { x: 0, y: 0, size: 90 });
		currentUser.mockResolvedValue(user);

		const first = await GET(request, { params: Promise.resolve({ userId: user.id }) });
		const etag = first.headers.get("etag");
		expect(etag).not.toBeNull();

		const conditional = new Request("http://localhost/api/avatar/x", {
			headers: { "If-None-Match": etag as string },
		});
		const second = await GET(conditional, { params: Promise.resolve({ userId: user.id }) });

		expect(second.status).toBe(304);
		expect(second.headers.get("etag")).toBe(etag);
		expect(second.headers.get("cache-control")).toContain("private");
		expect((await second.arrayBuffer()).byteLength).toBe(0);
	});

	it("still serves the bytes when the caller holds a different render", async () => {
		const user = await makeUser();
		await setAvatar(user.id, await pngOf(90, 90), { x: 0, y: 0, size: 90 });
		currentUser.mockResolvedValue(user);

		// The tag a caller would hold from before a re-crop: same shape, different stamp.
		const stale = new Request("http://localhost/api/avatar/x", { headers: { "If-None-Match": '"1"' } });
		const response = await GET(stale, { params: Promise.resolve({ userId: user.id }) });

		expect(response.status).toBe(200);
		expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
	});
});
