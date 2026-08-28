import { describe, expect, it } from "vitest";
import { presentation } from "@/app/(panel)/audit/chain-banner";

/**
 * How the Audit tab's banner draws each state the chain can be in.
 *
 * Only `presentation` is exercised, and nothing here renders: it is a pure function from
 * `ChainStatus["ok"]` to a set of classes and an icon, which is the whole of the banner's decision.
 * `vitest.config.mts` runs in a Node environment and says React component tests should get their own
 * project entry rather than change that — this needs neither, because there is no component in it.
 *
 * The four cases below are one property: an incomplete chain is drawn as none of the other three. That
 * is not decoration. `"incomplete"` means the record verified from the epoch onwards and what came
 * before it left before archiving existed — a retention setting doing its job on every install upgraded
 * from the storage foundation. Drawn as the failure it accuses an operator of tampering; drawn as a
 * whole chain it claims verification reached further back than it did; drawn as the untouched banner it
 * says nobody has asked, when somebody has and got an answer.
 */
describe("presentation", () => {
	it("draws an incomplete chain as neither a whole one nor a broken one", () => {
		const incomplete = presentation("incomplete");

		// The one this task exists for. Goes red if the `"incomplete"` branch is dropped or reordered
		// below the `false` one — and note that `ok` being a truthy string is exactly what makes that
		// silent: no compiler complains, and the banner turns red over a retention setting.
		expect(incomplete.tone).not.toBe(presentation(false).tone);
		expect(incomplete.Icon).not.toBe(presentation(false).Icon);
		// And not the whole chain's, which would say the record verified further back than it did.
		expect(incomplete.tone).not.toBe(presentation(true).tone);
	});

	it("does not draw an answered chain as one nobody has asked about", () => {
		// The quiet way this regresses: delete the `"incomplete"` branch and it falls through to the
		// fallback, which is a real colour with a real meaning — "not verified in this session" — and no
		// test comparing it against the failure would notice.
		expect(presentation("incomplete").tone).not.toBe(presentation(null).tone);
		expect(presentation("incomplete").Icon).not.toBe(presentation(null).Icon);
	});
});
