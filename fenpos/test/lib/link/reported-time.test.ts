import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const { plausibleTime } = await import("@/lib/link/reported-time");

/**
 * How far an agent is believed about when something happened.
 *
 * The field is written to columns retention sweeps on, so the two directions fail differently and
 * the bounds are deliberately not symmetric. A time far in the past has a row archived and deleted
 * on the next pass; a time far in the future has it swept by nothing, ever. Backdating is also
 * sometimes truthful — job state reconciles on reconnect, so a receipt that finished during an
 * outage is reported hours later with the time it really finished — while a forward drift never is.
 */
describe("reading a time an agent reported", () => {
	const NOW = Date.parse("2026-09-03T12:00:00.000Z");
	const at = (iso: string) => plausibleTime(iso, "job update", {}, NOW).toISOString();

	it("believes a time that agrees with this server's clock", () => {
		expect(at("2026-09-03T11:59:59.000Z")).toBe("2026-09-03T11:59:59.000Z");
	});

	it("believes a backdated time inside the day it allows", () => {
		// A job that finished during a six-hour outage and was reported on reconnect. Squashing this
		// would lose a real fact and make every line of the backlog claim the same moment.
		expect(at("2026-09-03T06:00:00.000Z")).toBe("2026-09-03T06:00:00.000Z");
	});

	it("pulls a time from last year forward to the edge of what it allows", () => {
		// Left alone, the next retention pass archives and deletes this row immediately — which is how
		// an agent would remove its own evidence without deleting anything.
		expect(at("2025-01-01T00:00:00.000Z")).toBe("2026-09-02T12:00:00.000Z");
	});

	it("pulls a time from next year back to the edge of what it allows", () => {
		// Left alone, nothing ever sweeps this row.
		expect(at("2027-01-01T00:00:00.000Z")).toBe("2026-09-03T13:00:00.000Z");
	});

	it("allows an hour of forward clock skew and no more", () => {
		expect(at("2026-09-03T12:59:59.000Z")).toBe("2026-09-03T12:59:59.000Z");
		expect(at("2026-09-03T13:00:01.000Z")).toBe("2026-09-03T13:00:00.000Z");
	});

	it("allows a day of backdating and no more", () => {
		expect(at("2026-09-02T12:00:01.000Z")).toBe("2026-09-02T12:00:01.000Z");
		expect(at("2026-09-02T11:59:59.000Z")).toBe("2026-09-02T12:00:00.000Z");
	});

	it("falls back to this server's clock when the value is not a time at all", () => {
		// Unreachable through a frame the schema accepted, and the one case with nothing to salvage.
		expect(at("not a timestamp")).toBe("2026-09-03T12:00:00.000Z");
	});
});
