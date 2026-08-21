import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { envSchema } from "@/lib/env";
import { ApiError } from "@/lib/errors";
import { getPublicAddress } from "@/lib/public-url";
import { setSetting } from "@/lib/settings/settings-service";

/**
 * Tests for the address agents are told to dial.
 *
 * `next/headers` has no request to read outside of Next's own server, so it is stubbed here with
 * the headers a proxied request would carry. This is the first test file in the repo to stub it;
 * later files needing the same stub should follow this shape. `vi.mock` calls are hoisted above
 * every import in this file, `getPublicAddress`'s included, so the stub is in place before it runs.
 */
vi.mock("next/headers", () => ({
	headers: vi.fn(async () => new Headers({ "x-forwarded-proto": "https", "x-forwarded-host": "panel.internal" })),
}));

describe("getPublicAddress", () => {
	beforeEach(async () => {
		await prisma.setting.deleteMany();
	});

	it("uses the configured address when one is saved", async () => {
		await setSetting("server.publicUrl", "https://fenpos.example.com");
		expect(await getPublicAddress()).toEqual({ url: "https://fenpos.example.com", source: "configured" });
	});

	it("strips a trailing slash from the configured address", async () => {
		await setSetting("server.publicUrl", "https://fenpos.example.com/");
		expect((await getPublicAddress()).url).toBe("https://fenpos.example.com");
	});

	it("derives from the request when nothing is saved", async () => {
		expect(await getPublicAddress()).toEqual({ url: "https://panel.internal", source: "request" });
	});

	it("refuses an address that is not an absolute http or https URL", async () => {
		await expect(setSetting("server.publicUrl", "fenpos.example.com")).rejects.toThrow(ApiError);
		await expect(setSetting("server.publicUrl", "ftp://fenpos.example.com")).rejects.toThrow(ApiError);
	});

	it("accepts an empty value, meaning derive from the request", async () => {
		await setSetting("server.publicUrl", "");
		expect((await getPublicAddress()).source).toBe("request");
	});

	it("no longer declares PUBLIC_URL as an environment variable", () => {
		// The behavioural check below cannot fail on its own: `env.ts` parses `process.env` at
		// module load, long before a test body could set `PUBLIC_URL`, so re-adding it to
		// `envSchema` and restoring `getPublicAddress`'s `env.PUBLIC_URL` branch would leave that
		// check green regardless. This is the structural assertion that actually pins the removal
		// down — it fails the moment `PUBLIC_URL` reappears in the schema, whether or not anything
		// reads it afterwards.
		expect(Object.keys(envSchema.shape)).not.toContain("PUBLIC_URL");
	});

	it("ignores PUBLIC_URL in the environment even when one happens to be set", async () => {
		// Not a regression test on its own — see the structural assertion above — but worth keeping
		// as a behavioural sanity check now that it can no longer be the only guard.
		process.env.PUBLIC_URL = "https://stale.example.com";
		try {
			expect((await getPublicAddress()).url).not.toBe("https://stale.example.com");
		} finally {
			delete process.env.PUBLIC_URL;
		}
	});

	it("stores the address as quoted JSON, not as bare text", async () => {
		// The regression this guards against: a write path that reverted to `String(value)` would
		// store the URL unquoted, which is not valid JSON, so the next read would fail to parse it
		// and the setting would silently revert to its default.
		await setSetting("server.publicUrl", "https://fenpos.example.com");
		const row = await prisma.setting.findUnique({ where: { key: "server.publicUrl" } });
		expect(row?.value).toBe(JSON.stringify("https://fenpos.example.com"));
		expect(row?.value).toBe('"https://fenpos.example.com"');
	});
});
