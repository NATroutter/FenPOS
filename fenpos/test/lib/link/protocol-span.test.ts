import { describe, expect, it } from "vitest";
import { spanSchema } from "@/lib/link/protocol";

/**
 * The span text rule exists because the agent has no escaping layer: it writes this text to
 * the port through a single-byte codepage, so a control character arrives as a command.
 */
describe("spanSchema.text", () => {
	const base = { bold: false, underline: 0 as const, invert: false, widthMult: 1, heightMult: 1, font: "A" as const };

	it.each(["\x1b", "\x1d", "\x00", "\t", "\x7f", "\x9b"])("refuses %j", (character) => {
		expect(spanSchema.safeParse({ ...base, text: `ab${character}cd` }).success).toBe(false);
	});

	it("accepts the characters a receipt actually contains", () => {
		expect(spanSchema.safeParse({ ...base, text: "Kahvi 2,50 EUR - Aamiainen" }).success).toBe(true);
	});
});
