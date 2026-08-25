import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/errors";
import { resolveVariables } from "@/lib/markup/resolve-variables";
import { setSetting } from "@/lib/settings/settings-service";
import type { OffsetUnit, VariableDefinition } from "@/lib/variables/definition";
import type { SuppliedValue } from "@/lib/variables/supplied";
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

	/** A text value as `readSuppliedVariables` now hands them over. */
	const text = (value: string): SuppliedValue => ({ kind: "text", text: value });

	/** A date the caller described and this install renders. */
	const moment = (pattern: string, offset: { amount: number; unit: OffsetUnit } | null = null): SuppliedValue => ({
		kind: "moment",
		pattern,
		offset,
	});

	const job = (supplied: Record<string, SuppliedValue> = {}) => ({
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

		const context = await resolveVariables(job({ phone: text("this-job") }), NOW);
		expect(context?.values.get("phone")).toBe("this-job");
	});

	it("refuses a supplied value for a variable that is not overridable", async () => {
		await createVariable(definition());

		await expect(resolveVariables(job({ phone: text("this-job") }), NOW)).rejects.toBeInstanceOf(ApiError);
	});

	it("accepts a supplied name no variable defines", async () => {
		const context = await resolveVariables(job({ order_id: text("1041") }), NOW);

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

		await expect(resolveVariables(job({ a: text("1"), b: text("2") }), NOW)).rejects.toBeInstanceOf(ApiError);
	});

	it("refuses supplied values when the install does not accept them", async () => {
		await setSetting("variables.allowRequestValues", false);

		await expect(resolveVariables(job({ a: text("1") }), NOW)).rejects.toBeInstanceOf(ApiError);
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

			await expect(resolveVariables(job({ bad_date: text("whatever") }), NOW)).rejects.toBeInstanceOf(ApiError);
		});

		it("accepts a job-supplied value for it when the row is marked overridable", async () => {
			await prisma.variable.create({
				data: { name: "bad_date", kind: "DATETIME", pattern: "YYYY-MM-DD", overridable: true },
			});

			const context = await resolveVariables(job({ bad_date: text("2026-08-25") }), NOW);
			expect(context?.values.get("bad_date")).toBe("2026-08-25");
		});
	});

	/**
	 * A date the caller described rather than pre-formatted.
	 *
	 * The property every test here circles is the one the feature exists for: the caller owns the
	 * *shape* of the date — the pattern, the offset — and the install owns the *rendering*, the zone
	 * and the locale. A caller in another zone that formats `MM/dd` must not be able to put a date on
	 * this install's paper that disagrees with every other date on the same receipt.
	 */
	describe("a date the request described", () => {
		it("renders in the install's zone, not the caller's", async () => {
			await setSetting("variables.timezone", "Europe/Helsinki");

			// NOW is 21:07 UTC on the 25th, which is 00:07 on the 26th in Helsinki. A caller sending
			// its own pre-formatted date would have said the 25th.
			const context = await resolveVariables(job({ printed_at: moment("dd.MM.yyyy HH:mm") }), NOW);
			expect(context?.values.get("printed_at")).toBe("26.08.2026 00:07");
		});

		it("does the calendar arithmetic in the install's zone too", async () => {
			await setSetting("variables.timezone", "Europe/Helsinki");

			const context = await resolveVariables(
				job({ return_by: moment("dd.MM.yyyy", { amount: 14, unit: "DAYS" }) }),
				NOW,
			);
			expect(context?.values.get("return_by")).toBe("09.09.2026");
		});

		it("treats an absent offset as the instant the job compiles at", async () => {
			await setSetting("variables.timezone", "Africa/Abidjan");

			const context = await resolveVariables(job({ printed_at: moment("dd.MM.yyyy HH:mm") }), NOW);
			expect(context?.values.get("printed_at")).toBe("25.08.2026 21:07");
		});

		it("renders in the install's locale, not in English regardless", async () => {
			await setSetting("variables.timezone", "Africa/Abidjan");
			await setSetting("variables.locale", "fi-FI");

			const context = await resolveVariables(job({ day: moment("cccc") }), NOW);
			// Asserted as a difference rather than as the expected word, following the same reasoning
			// `evaluate.test.ts` writes out: naming it would put a language this product does not speak
			// into its own suite, and would pin the assertion to one release of date-fns's locale data.
			expect(context?.values.get("day")).not.toBe("Tuesday");
			expect(context?.values.get("day")).not.toBe("");
		});

		it("shares the job's single instant with a variable the panel defines", async () => {
			await setSetting("variables.timezone", "Africa/Abidjan");
			await createVariable(definition({ name: "defined", kind: "DATETIME", value: null, pattern: "HH:mm:ss" }));

			const context = await resolveVariables(job({ sent: moment("HH:mm:ss") }), NOW);
			// Not merely equal by luck: `resolveVariables` captures one `now` for the whole job, so two
			// dates on one receipt cannot straddle a second boundary and disagree.
			expect(context?.values.get("sent")).toBe(context?.values.get("defined"));
		});

		it("refuses the request when the pattern cannot be rendered", async () => {
			// `YYYY` is week-numbering year, which date-fns rejects outright because it is almost always
			// a mistake for `yyyy`.
			await expect(resolveVariables(job({ d: moment("YYYY-MM-DD") }), NOW)).rejects.toBeInstanceOf(ApiError);
		});

		it("refuses only that request, leaving the next job on the install printing", async () => {
			// The containment the parent feature's Critical bug was about, restated at this seam: an
			// unrenderable pattern is one caller's mistake, not an install-wide outage.
			await createVariable(definition());

			await expect(resolveVariables(job({ d: moment("YYYY-MM-DD") }), NOW)).rejects.toBeInstanceOf(ApiError);

			const context = await resolveVariables(job(), NOW);
			expect(context?.values.get("phone")).toBe("install-wide");
		});

		it("measures the rendered text against the install's value cap", async () => {
			await setSetting("variables.maxValueChars", 4);

			await expect(resolveVariables(job({ d: moment("dd.MM.yyyy") }), NOW)).rejects.toBeInstanceOf(ApiError);
		});

		it("caps the rendered text rather than the pattern, so quoted literals cannot slip past", async () => {
			await setSetting("variables.maxValueChars", 20);

			// A date-fns pattern may carry quoted literal text, so a pattern is a way to put arbitrary
			// characters on paper. This one is well under the 120-character pattern bound and renders to
			// 30 characters — and it is the 30 that has to be refused, or the cap every string value
			// obeys is bypassed by sending an object instead.
			await expect(resolveVariables(job({ d: moment(`'${"a".repeat(30)}'`) }), NOW)).rejects.toBeInstanceOf(ApiError);
		});

		it("accepts rendered text exactly at the cap", async () => {
			await setSetting("variables.timezone", "Africa/Abidjan");
			await setSetting("variables.maxValueChars", 10);

			const context = await resolveVariables(job({ d: moment("dd.MM.yyyy") }), NOW);
			expect(context?.values.get("d")).toBe("25.08.2026");
		});

		it("applies the overridable gate exactly as it does to a text value", async () => {
			await createVariable(definition({ name: "return_by", kind: "DATETIME", value: null, pattern: "dd.MM.yyyy" }));

			await expect(resolveVariables(job({ return_by: moment("dd.MM.yyyy") }), NOW)).rejects.toBeInstanceOf(ApiError);
		});

		it("replaces an overridable definition, pattern and all", async () => {
			await setSetting("variables.timezone", "Africa/Abidjan");
			await createVariable(
				definition({ name: "return_by", kind: "DATETIME", value: null, pattern: "yyyy", overridable: true }),
			);

			const context = await resolveVariables(
				job({ return_by: moment("dd.MM.yyyy", { amount: 1, unit: "DAYS" }) }),
				NOW,
			);
			expect(context?.values.get("return_by")).toBe("26.08.2026");
		});

		it("counts against the per-request cap like any other value", async () => {
			await setSetting("variables.maxPerRequest", 1);

			await expect(resolveVariables(job({ a: text("1"), b: moment("yyyy") }), NOW)).rejects.toBeInstanceOf(ApiError);
		});

		it("is refused outright when the install does not accept values from requests", async () => {
			await setSetting("variables.allowRequestValues", false);

			await expect(resolveVariables(job({ d: moment("yyyy") }), NOW)).rejects.toBeInstanceOf(ApiError);
		});
	});
});
