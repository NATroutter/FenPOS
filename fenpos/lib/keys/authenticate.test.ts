import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/errors";
import {
	type AuthenticatedKey,
	authenticateKey,
	bearerToken,
	requireGrantedDevice,
	requirePermission,
} from "@/lib/keys/authenticate";
import { createApiKey, revokeApiKey } from "@/lib/keys/key-service";

/**
 * Tests for the public API's authorisation boundary.
 *
 * The case that matters most is the one that looks like a mistake: a key addressing a device it
 * has no grant for gets `unknown_device`, not `insufficient_permission`. Distinguishing them
 * would let a caller map every printer in the install by probing names and watching which answer
 * came back, so the indistinguishability is the feature.
 */
describe("API key authorisation", () => {
	let agentId: string;
	let kitchenId: string;
	let barId: string;

	beforeEach(async () => {
		await prisma.apiKey.deleteMany();
		await prisma.device.deleteMany();
		await prisma.agent.deleteMany();

		const agent = await prisma.agent.create({ data: { name: "site-a" }, select: { id: true } });
		agentId = agent.id;

		kitchenId = (
			await prisma.device.create({
				data: { agentId, name: "kitchen", port: "COM3" },
				select: { id: true },
			})
		).id;
		barId = (await prisma.device.create({ data: { agentId, name: "bar", port: "COM4" }, select: { id: true } })).id;
	});

	/** Mints a key and returns both its secret and what an authenticated call sees. */
	const mint = async (permissions: string[], deviceIds: string[]) => {
		const created = await createApiKey("till", permissions, deviceIds);
		return { id: created.id, secret: created.secret };
	};

	const authenticate = (secret: string | null): Promise<AuthenticatedKey> =>
		authenticateKey(
			new Request("https://fenpos.test/api/print/site-a/kitchen", {
				headers: secret ? { authorization: `Bearer ${secret}` } : {},
			}),
		);

	/** Runs a call and returns the error, failing the test if it succeeded. */
	const refusal = async (work: () => Promise<unknown>): Promise<ApiError> => {
		try {
			await work();
		} catch (thrown) {
			if (thrown instanceof ApiError) {
				return thrown;
			}
			throw thrown;
		}
		throw new Error("expected the call to be refused");
	};

	// -----------------------------------------------------------------------
	// Presenting a credential
	// -----------------------------------------------------------------------

	it("reads a bearer token from the header", () => {
		expect(bearerToken("Bearer abc123")).toBe("abc123");
		expect(bearerToken("bearer abc123")).toBe("abc123");
	});

	it("reads no token from an absent or unrecognised header", () => {
		expect(bearerToken(null)).toBeNull();
		expect(bearerToken("Basic abc123")).toBeNull();
	});

	it("refuses a request with no key", async () => {
		expect((await refusal(() => authenticate(null))).code).toBe("missing_key");
	});

	it("refuses an unknown key", async () => {
		expect((await refusal(() => authenticate("fpk_nonsense"))).code).toBe("invalid_key");
	});

	it("refuses a revoked key with the same answer as an unknown one", async () => {
		const key = await mint(["print"], [kitchenId]);
		await revokeApiKey(key.id);

		// One response for both, so the endpoint cannot be used to test whether a key was ever
		// valid.
		expect((await refusal(() => authenticate(key.secret))).code).toBe("invalid_key");
	});

	it("accepts a valid key and reports what it may do", async () => {
		const key = await mint(["print", "jobs:read"], [kitchenId]);

		const authenticated = await authenticate(key.secret);

		expect(authenticated.id).toBe(key.id);
		// Compared as a set: the grants come back in whatever order the database returns rows,
		// and nothing depends on that order.
		expect([...authenticated.permissions].sort()).toEqual(["jobs:read", "print"]);
	});

	it("issues a distinct secret per key", async () => {
		const first = await mint(["print"], []);
		const second = await createApiKey("other", ["print"], []);

		expect(first.secret).not.toBe(second.secret);
	});

	it("never stores the secret itself", async () => {
		const key = await mint(["print"], []);

		const row = await prisma.apiKey.findUnique({ where: { id: key.id } });
		expect(row?.keyHash).not.toBe(key.secret);
		expect(JSON.stringify(row)).not.toContain(key.secret);
	});

	// -----------------------------------------------------------------------
	// Permissions
	// -----------------------------------------------------------------------

	it("allows an action the key holds the permission for", async () => {
		const authenticated = await authenticate((await mint(["print"], [])).secret);

		expect(() => requirePermission(authenticated, "print")).not.toThrow();
	});

	it("refuses an action the key lacks the permission for", async () => {
		const authenticated = await authenticate((await mint(["jobs:read"], [])).secret);

		try {
			requirePermission(authenticated, "print");
			throw new Error("expected a refusal");
		} catch (error) {
			expect(error).toBeInstanceOf(ApiError);
			expect((error as ApiError).code).toBe("insufficient_permission");
		}
	});

	it("grants nothing to a key with no permissions", async () => {
		// A key created but not yet configured must be inert, never permissive.
		const authenticated = await authenticate((await mint([], [kitchenId])).secret);

		expect(authenticated.permissions).toEqual([]);
	});

	// -----------------------------------------------------------------------
	// Device grants
	// -----------------------------------------------------------------------

	it("resolves a device the key is granted", async () => {
		const authenticated = await authenticate((await mint(["print"], [kitchenId])).secret);

		const device = await requireGrantedDevice(authenticated, "site-a", "kitchen");

		expect(device.id).toBe(kitchenId);
		expect(device.agentId).toBe(agentId);
	});

	it("reports a device the key is not granted as unknown", async () => {
		const authenticated = await authenticate((await mint(["print"], [kitchenId])).secret);

		const thrown = await refusal(() => requireGrantedDevice(authenticated, "site-a", "bar"));

		// Deliberately the same as a device that does not exist. Anything else would let a caller
		// enumerate the install's printers.
		expect(thrown.code).toBe("unknown_device");
	});

	it("reports a device that does not exist the same way", async () => {
		const authenticated = await authenticate((await mint(["print"], [kitchenId])).secret);

		const missing = await refusal(() => requireGrantedDevice(authenticated, "site-a", "nowhere"));
		const forbidden = await refusal(() => requireGrantedDevice(authenticated, "site-a", "bar"));

		expect(missing.code).toBe(forbidden.code);
		expect(missing.message).not.toBe("");
	});

	it("refuses a device on an agent the path names wrongly", async () => {
		const authenticated = await authenticate((await mint(["print"], [kitchenId])).secret);

		expect((await refusal(() => requireGrantedDevice(authenticated, "site-b", "kitchen"))).code).toBe("unknown_device");
	});

	it("grants no devices to a key with no grants", async () => {
		const authenticated = await authenticate((await mint(["print"], [])).secret);

		expect((await refusal(() => requireGrantedDevice(authenticated, "site-a", "kitchen"))).code).toBe("unknown_device");
	});

	it("keeps two keys' grants apart", async () => {
		const kitchenKey = await authenticate((await mint(["print"], [kitchenId])).secret);
		const barKey = await authenticate((await createApiKey("bar-till", ["print"], [barId])).secret);

		await expect(requireGrantedDevice(kitchenKey, "site-a", "kitchen")).resolves.toBeDefined();
		await expect(requireGrantedDevice(barKey, "site-a", "bar")).resolves.toBeDefined();
		expect((await refusal(() => requireGrantedDevice(barKey, "site-a", "kitchen"))).code).toBe("unknown_device");
	});
});
