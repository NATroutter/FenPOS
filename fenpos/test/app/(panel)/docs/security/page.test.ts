import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelUser } from "@/lib/auth/require-session";

/**
 * The Security docs page's gate.
 *
 * Neither existing docs page has a test that renders it — `docs-check.test.ts` and `prose.test.ts`
 * beside this file check the API and markup pages' *claims* as text, since this project's tests run
 * in a Node environment and cannot render a page. This instead mirrors
 * `test/app/(auth)/enrol-2fa/page.test.ts`'s pattern, the one place in this codebase a gated Server
 * Component is actually invoked: `next/navigation`'s `redirect` is mocked to throw, because that is
 * how a Server Component signals a redirect, and the assertion is against what the page returns
 * rather than against pixels this suite cannot render.
 */
const redirected = vi.fn((destination: string) => {
	throw new Error(`REDIRECT:${destination}`);
});
vi.mock("next/navigation", () => ({ redirect: redirected }));

const currentSessionUser = vi.fn<() => Promise<PanelUser | null>>();
vi.mock("@/lib/auth/require-session", () => ({ requireSession: async () => currentSessionUser() }));

const { default: SecurityDocsPage } = await import("@/app/(panel)/docs/security/page");
const { prisma } = await import("@/lib/db");

/**
 * A signed-in account, optionally holding the permissions named.
 *
 * @param id the account id, unique within this file
 * @param permissions what to grant it
 * @returns the account, already installed as the current session
 */
async function account(id: string, ...permissions: string[]): Promise<PanelUser> {
	await prisma.user.create({ data: { id, name: id, email: `${id}@example.com` } });
	for (const permission of permissions) {
		await prisma.userPermission.create({ data: { userId: id, permission } });
	}
	const user: PanelUser = {
		id,
		name: id,
		email: `${id}@example.com`,
		isSuperuser: false,
		mustChangePassword: false,
		sessionId: `${id}-session`,
		twoFactorEnabled: false,
	};
	currentSessionUser.mockResolvedValue(user);
	return user;
}

describe("/docs/security", () => {
	beforeEach(async () => {
		redirected.mockClear();
		await prisma.setting.deleteMany({});
		await prisma.userPermission.deleteMany({});
		await prisma.user.deleteMany({});
		currentSessionUser.mockReset();
	});

	it("refuses a visitor without docs:read", async () => {
		await account("sec-refused");

		await expect(SecurityDocsPage()).rejects.toThrow("REDIRECT:/no-access");
	});

	it("renders for a visitor holding docs:read", async () => {
		await account("sec-granted", "docs:read");

		await expect(SecurityDocsPage()).resolves.toBeTruthy();
		expect(redirected).not.toHaveBeenCalled();
	});
});
