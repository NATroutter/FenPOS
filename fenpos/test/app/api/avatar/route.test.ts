import { describe, expect, it, vi } from "vitest";
import type { PanelUser } from "@/lib/auth/require-session";

/**
 * `currentUser` is stubbed the way `test/app/api/events/route.test.ts` stubs it: the mock spreads
 * the real module via `importActual` and overrides only `currentUser`, referenced through a wrapper
 * closure rather than captured directly, so the outer `const` below is not read before its own
 * initialiser runs. Nothing else this route touches — `readAvatar`, `setAvatar` — comes from
 * `@/lib/auth/require-session`, so nothing else needed the real exports; the spread is kept anyway,
 * both to match the established pattern and as a guard against a future caller of this route pulling
 * in another export of the module unnoticed.
 */
const currentUser = vi.fn<() => Promise<PanelUser | null>>();
vi.mock("@/lib/auth/require-session", async (importActual) => ({
	...(await importActual<typeof import("@/lib/auth/require-session")>()),
	currentUser: () => currentUser(),
}));

import { GET } from "@/app/api/avatar/[userId]/route";
import { readAvatar, setAvatar } from "@/lib/auth/avatar-service";
import { makeUser } from "@/test/helpers/accounts";
import { pngOf } from "@/test/helpers/images";

const request = new Request("http://localhost/api/avatar/x");

describe("GET /api/avatar/[userId]", () => {
	it("refuses anyone not signed in", async () => {
		currentUser.mockResolvedValue(null);
		const user = await makeUser();

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
});
