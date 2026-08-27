import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelUser } from "@/lib/auth/require-session";
import { setSetting } from "@/lib/settings/settings-service";

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

	/**
	 * The page's doc comment promises it is "written against this install rather than in the
	 * abstract", and `auth.lockoutMinutes` is configurable from 1 to 1440. The Signing-in section
	 * already rendered the configured value; the Recovering section said "fifteen-minute" as a
	 * literal, so any install that changed the setting read a page that disagreed with itself about
	 * the same clock. A number nothing on this install is set to is what makes that visible.
	 */
	it("quotes this install's lockout duration in Recovering, not a hardcoded fifteen", async () => {
		await account("sec-lockout", "docs:read");
		await setSetting("auth.lockoutAfterFailures", 3);
		await setSetting("auth.lockoutMinutes", 47);

		const text = renderedText(await SecurityDocsPage());

		expect(text).toContain("47-minute clock");
		expect(text).not.toContain("fifteen-minute");
	});

	/**
	 * The page told operators that "every row the panel or the API writes to the audit record stays",
	 * which reads as a promise that API traffic is in there. It is not: no route under `app/api`
	 * writes a row at all. This is the page an operator reads to decide whether the Audit tab can
	 * answer their question, so the sentence was not a stylistic one.
	 *
	 * Both halves are asserted, because either one alone would rot. The page's claim is pinned to the
	 * tree it describes: the day a route starts writing rows, this goes red on the second assertion
	 * and the page is the thing that has to change.
	 */
	it("says the v1 API writes no audit rows, and no route under app/api writes one", async () => {
		await account("sec-audit", "docs:read");

		const text = renderedText(await SecurityDocsPage());
		expect(text).toContain("The v1 API writes none.");

		const writers = apiRouteSources().filter(([, source]) => /\b(recordAudit|appendAuditEvent)\s*\(/.test(source));
		expect(writers.map(([file]) => file)).toEqual([]);
		// The walker itself must not pass by finding nothing: `app/api` really does hold routes.
		expect(apiRouteSources().length).toBeGreaterThan(10);
	});
});

/**
 * Every `.ts`/`.tsx` file under `app/api`, with its text.
 *
 * @returns pairs of path and source, for the audit-writer scan above
 */
function apiRouteSources(): [string, string][] {
	const found: [string, string][] = [];
	const walk = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				walk(path);
			} else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
				found.push([path, readFileSync(path, "utf8")]);
			}
		}
	};
	walk(join("app", "api"));
	return found;
}

/**
 * The text a rendered element tree would show, without rendering it.
 *
 * This suite runs in a Node environment with no renderer, and the sibling `docs-check.test.ts`
 * explains why the other two docs pages are read as source text instead. That trick cannot check a
 * value the page *computes*, which is exactly what the assertions above are about, so this walks the
 * element tree the page returns and concatenates its leaves. Component functions are never called —
 * only `props.children` is followed — which is enough, because every claim under test is written as
 * text in the page's own JSX.
 *
 * @param node any node of the returned element tree
 * @returns the concatenated text of its leaves
 */
function renderedText(node: unknown): string {
	if (typeof node === "string" || typeof node === "number") {
		return String(node);
	}
	if (Array.isArray(node)) {
		return node.map(renderedText).join("");
	}
	if (typeof node === "object" && node !== null && "props" in node) {
		return renderedText((node as { props?: { children?: unknown } }).props?.children);
	}
	return "";
}
