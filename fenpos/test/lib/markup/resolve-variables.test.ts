import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/errors";
import { resolveVariables } from "@/lib/markup/resolve-variables";
import { setSetting } from "@/lib/settings/settings-service";
import type { VariableDefinition } from "@/lib/variables/definition";
import { createVariable, setDeviceOverride } from "@/lib/variables/variable-service";

const NOW = new Date("2026-08-25T21:07:03.000Z");

const definition = (over: Partial<VariableDefinition> = {}): VariableDefinition => ({
	name: "phone",
	kind: "STATIC",
	value: "install-wide",
	pattern: null,
	offsetAmount: null,
	offsetUnit: null,
	source: null,
	overridable: false,
	description: null,
	...over,
});

describe("resolveVariables", () => {
	let deviceId: string;

	const job = (supplied: Record<string, string> = {}) => ({
		deviceId,
		context: {
			deviceName: "counter",
			paperColumns: "42",
			paperWidth: "80mm",
			codepage: "CP858",
			agentName: "counter-pi",
			agentHostname: "counter-pi.local",
			agentPlatform: "linux",
			agentVersion: "1.4.0",
			apiKeyName: "till-1",
			idempotencyKey: "order-1041",
			serverUrl: "https://print.example.test",
		},
		supplied,
	});

	beforeEach(async () => {
		await prisma.deviceVariable.deleteMany();
		await prisma.variable.deleteMany();
		await prisma.device.deleteMany();
		await prisma.agent.deleteMany();
		await prisma.setting.deleteMany();

		const agent = await prisma.agent.create({ data: { name: "counter-pi" } });
		const device = await prisma.device.create({ data: { agentId: agent.id, name: "counter", port: "COM1" } });
		deviceId = device.id;
	});

	it("returns null when variables are switched off, meaning braces are text", async () => {
		await setSetting("variables.enabled", false);
		await createVariable(definition());

		expect(await resolveVariables(job(), NOW)).toBeNull();
	});

	it("resolves an install-wide value", async () => {
		await createVariable(definition());

		const context = await resolveVariables(job(), NOW);
		expect(context?.values.get("phone")).toBe("install-wide");
	});

	it("prefers a device override over the install-wide value", async () => {
		const created = await createVariable(definition());
		await setDeviceOverride(deviceId, created.id, "this-printer");

		const context = await resolveVariables(job(), NOW);
		expect(context?.values.get("phone")).toBe("this-printer");
	});

	it("prefers a supplied value over a device override", async () => {
		const created = await createVariable(definition({ overridable: true }));
		await setDeviceOverride(deviceId, created.id, "this-printer");

		const context = await resolveVariables(job({ phone: "this-job" }), NOW);
		expect(context?.values.get("phone")).toBe("this-job");
	});

	it("refuses a supplied value for a variable that is not overridable", async () => {
		await createVariable(definition());

		await expect(resolveVariables(job({ phone: "this-job" }), NOW)).rejects.toBeInstanceOf(ApiError);
	});

	it("accepts a supplied name no variable defines", async () => {
		const context = await resolveVariables(job({ order_id: "1041" }), NOW);

		expect(context?.values.get("order_id")).toBe("1041");
	});

	it("evaluates a datetime against the passed-in instant", async () => {
		// Pinned to a zone with no offset and no DST, rather than left on the `system` default: this
		// suite runs wherever it runs, and "system" would make this assertion depend on the machine's
		// own zone rather than on the behaviour under test. `variables.timezone`'s enum is built from
		// `Intl.supportedValuesOf("timeZone")`, which does not offer a plain "UTC" entry, so
		// Africa/Abidjan — permanently UTC+0 — stands in for it. `formats a datetime in the configured
		// zone`, below, is what actually exercises a non-trivial `variables.timezone`.
		await setSetting("variables.timezone", "Africa/Abidjan");
		await createVariable(definition({ name: "time_hm", kind: "DATETIME", value: null, pattern: "HH:mm" }));

		const context = await resolveVariables(job(), NOW);
		expect(context?.values.get("time_hm")).toBe("21:07");
	});

	it("gives every datetime on one job the same instant", async () => {
		await createVariable(definition({ name: "a", kind: "DATETIME", value: null, pattern: "ss" }));
		await createVariable(definition({ name: "b", kind: "DATETIME", value: null, pattern: "ss" }));

		const context = await resolveVariables(job(), NOW);
		expect(context?.values.get("a")).toBe(context?.values.get("b"));
	});

	it("formats a datetime in the configured zone", async () => {
		await setSetting("variables.timezone", "Europe/Helsinki");
		await createVariable(definition({ name: "d", kind: "DATETIME", value: null, pattern: "dd.MM.yyyy" }));

		const context = await resolveVariables(job(), NOW);
		expect(context?.values.get("d")).toBe("26.08.2026");
	});

	it("resolves a context variable from the print", async () => {
		await createVariable(definition({ name: "printer", kind: "CONTEXT", value: null, source: "DEVICE_NAME" }));

		const context = await resolveVariables(job(), NOW);
		expect(context?.values.get("printer")).toBe("counter");
	});

	it("carries the per-element limit through", async () => {
		await setSetting("variables.maxPerElement", 7);

		expect((await resolveVariables(job(), NOW))?.maxPerElement).toBe(7);
	});

	it("refuses more supplied values than the cap allows", async () => {
		await setSetting("variables.maxPerRequest", 1);

		await expect(resolveVariables(job({ a: "1", b: "2" }), NOW)).rejects.toBeInstanceOf(ApiError);
	});

	it("refuses supplied values when the install does not accept them", async () => {
		await setSetting("variables.allowRequestValues", false);

		await expect(resolveVariables(job({ a: "1" }), NOW)).rejects.toBeInstanceOf(ApiError);
	});

	it("still resolves when the install does not accept supplied values and none were sent", async () => {
		await setSetting("variables.allowRequestValues", false);
		await createVariable(definition());

		expect((await resolveVariables(job(), NOW))?.values.get("phone")).toBe("install-wide");
	});

	/**
	 * The half of the fix that contains a bad row already in the table.
	 *
	 * `createVariable` now refuses a pattern `date-fns` cannot render, so these rows are written
	 * straight through Prisma — which is exactly how the ones that matter got there: saved before that
	 * check existed, or by any future write path that forgets it. The property being pinned is the
	 * blast radius. This function evaluates *every* defined variable on *every* job, so a throw
	 * escaping it took down every printer, every key and every receipt on the install, as a 500 with
	 * no job row to explain itself. Omitting the name instead means only the receipts that actually
	 * reference it fail, and they fail as `unknown_variable`, naming it and its column.
	 */
	describe("a variable that cannot be evaluated", () => {
		/** Writes a row past the service, as one saved before `requireValid` learned to check patterns. */
		const storeUnrenderable = async (name: string) => {
			await prisma.variable.create({
				data: { name, kind: "DATETIME", pattern: "YYYY-MM-DD", overridable: false },
			});
		};

		it("does not fail the whole resolution", async () => {
			await storeUnrenderable("bad_date");
			await createVariable(definition());

			const context = await resolveVariables(job(), NOW);

			expect(context).not.toBeNull();
			expect(context?.values.get("phone")).toBe("install-wide");
		});

		it("is simply absent, which the parser reads as unknown_variable on the receipts that name it", async () => {
			await storeUnrenderable("bad_date");

			const context = await resolveVariables(job(), NOW);

			expect(context?.values.has("bad_date")).toBe(false);
		});

		/**
		 * A broken row must not become an overridable one. The check that refuses a job-supplied value
		 * asks whether the name is *defined*, not whether it evaluated — a row this install has an
		 * opinion about still has that opinion when it cannot be rendered.
		 */
		it("still refuses a job-supplied value for it, because it is defined and locked", async () => {
			await storeUnrenderable("bad_date");

			await expect(resolveVariables(job({ bad_date: "whatever" }), NOW)).rejects.toBeInstanceOf(ApiError);
		});

		it("accepts a job-supplied value for it when the row is marked overridable", async () => {
			await prisma.variable.create({
				data: { name: "bad_date", kind: "DATETIME", pattern: "YYYY-MM-DD", overridable: true },
			});

			const context = await resolveVariables(job({ bad_date: "2026-08-25" }), NOW);
			expect(context?.values.get("bad_date")).toBe("2026-08-25");
		});
	});
});
