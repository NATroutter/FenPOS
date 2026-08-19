import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/errors";
import { compiledJobSchema } from "@/lib/link/protocol";
import { type CompileLimits, type CompileSettings, compile, countTextLines, readRequest } from "@/lib/markup/compiler";

/**
 * Behavioural tests for the compile pipeline.
 *
 * Translated case for case from `PrintCompilerTest.java`, with the device fixture kept identical
 * — ten columns, CP858, five lines, twenty characters per line — so the expected outcomes carry
 * over unchanged. The limits are small on purpose: they can be exceeded by a short literal that
 * a reader can check by eye.
 */
describe("compile pipeline", () => {
	const settings: CompileSettings = {
		columns: 10,
		codepage: "CP858",
		onUnsupported: "REJECT",
		defaultWrap: true,
		defaultLinefeed: "LF",
	};

	const limits: CompileLimits = {
		maxLines: 5,
		maxLineChars: 20,
		maxTotalChars: 50,
		maxOutputLines: 3,
	};

	/** Runs a body through both stages, as a request handler does. */
	const run = (body: unknown) => {
		const request = readRequest(body, limits, settings);
		return compile("job-1", "kitchen", request, limits, settings);
	};

	/** Runs a body and returns the error, failing the test if it was accepted. */
	const error = (body: unknown): ApiError => {
		try {
			run(body);
		} catch (thrown) {
			if (thrown instanceof ApiError) {
				return thrown;
			}
			throw thrown;
		}
		throw new Error("expected the request to be refused");
	};

	it("compiles a valid request into a job", () => {
		const job = run({ data: ["Kahvi 2.50", "<bold>Yht</bold>"] });

		expect(job.lines).toHaveLength(2);
		expect(job.device).toBe("kitchen");
		expect(job.jobId).toBe("job-1");
		// Validated against the wire schema, because the agent parses against it: anything it
		// would reject must fail here rather than at the printer.
		expect(compiledJobSchema.safeParse(job).success).toBe(true);
	});

	// -----------------------------------------------------------------------
	// Request shape
	// -----------------------------------------------------------------------

	it("rejects a body that is not an object", () => {
		expect(error([1, 2, 3]).code).toBe("invalid_json");
		expect(error("a string").code).toBe("invalid_json");
		expect(error(null).code).toBe("invalid_json");
	});

	it("rejects a missing data field", () => {
		expect(error({}).code).toBe("missing_field");
	});

	it("rejects data that is not an array", () => {
		expect(error({ data: "one line" }).code).toBe("invalid_type");
	});

	it("rejects a non-string element and names its line", () => {
		const thrown = error({ data: ["ok", 42] });

		expect(thrown.code).toBe("invalid_type");
		expect(thrown.details.line).toBe(2);
	});

	it("rejects an unknown linefeed", () => {
		expect(error({ data: ["x"], linefeed: "CR" }).code).toBe("invalid_linefeed");
	});

	// -----------------------------------------------------------------------
	// Limits
	// -----------------------------------------------------------------------

	it("rejects too many elements", () => {
		expect(error({ data: Array.from({ length: 6 }, () => "x") }).code).toBe("too_many_lines");
	});

	it("rejects an element longer than the limit", () => {
		const thrown = error({ data: ["ok", "a".repeat(21)] });

		expect(thrown.code).toBe("line_too_long");
		expect(thrown.details.line).toBe(2);
	});

	it("rejects total text larger than the limit", () => {
		expect(error({ data: Array.from({ length: 3 }, () => "a".repeat(20)) }).code).toBe("text_too_large");
	});

	it("rejects too many lines after wrapping", () => {
		// Each element is within every input limit, but wraps to two lines at width 10, so only
		// the post-wrap count can catch this. Checking the submitted count alone would let a
		// short request produce an unbounded receipt.
		expect(error({ data: ["ab ab ab ab", "cd cd cd cd"] }).code).toBe("too_many_output_lines");
	});

	it("checks limits before parsing content", () => {
		// A request that is both oversized and malformed is refused for the cheaper reason,
		// without parsing megabytes of markup first.
		expect(error({ data: [`${"a".repeat(21)}<blink>`] }).code).toBe("line_too_long");
	});

	// -----------------------------------------------------------------------
	// Content
	// -----------------------------------------------------------------------

	it("reports a markup error with its line and column", () => {
		const thrown = error({ data: ["ok", "a <blink>b</blink>"] });

		expect(thrown.code).toBe("unknown_tag");
		expect(thrown.details.line).toBe(2);
		expect(thrown.details.column).toBe(3);
	});

	it("reports an unsupported character with everything needed to fix it", () => {
		const thrown = error({ data: ["ok", "Hello 😎"] });

		expect(thrown.code).toBe("unsupported_character");
		expect(thrown.details.line).toBe(2);
		expect(thrown.details.column).toBe(7);
		expect(thrown.details.character).toBe("😎");
		expect(thrown.details.codepage).toBe("CP858");
	});

	it("reports a control character with its position", () => {
		const thrown = error({ data: ["a\tb"] });

		expect(thrown.code).toBe("control_character");
		expect(thrown.details.line).toBe(1);
		expect(thrown.details.column).toBe(2);
	});

	// -----------------------------------------------------------------------
	// Wrapping and defaults
	// -----------------------------------------------------------------------

	it("wraps by default according to the device width", () => {
		const job = run({ data: ["ab ".repeat(4)] });

		expect(job.lines, "11 columns of text should wrap at width 10").toHaveLength(2);
	});

	it("takes the linefeed from the device when the request omits it", () => {
		expect(run({ data: ["x"] }).linefeed).toBe("LF");
	});

	it("takes the linefeed from the request when it supplies one", () => {
		expect(run({ data: ["x"], linefeed: "CRLF" }).linefeed).toBe("CRLF");
	});

	// -----------------------------------------------------------------------
	// Output shape
	// -----------------------------------------------------------------------

	it("expands a rule to the device width, since only the server knows it", () => {
		const job = run({ data: ["<hr>"] });

		expect(job.lines[0].spans[0].text).toBe("-".repeat(10));
		// The agent never has to know what a rule is: what crosses the link is always text.
		expect(job.lines[0].directives).toHaveLength(0);
	});

	it("carries cut and feed directives through to the wire", () => {
		const job = run({ data: ["done<feed=2>", "<cut=partial>"] });

		expect(job.lines[0].directives).toEqual([{ type: "FEED", lines: 2 }]);
		expect(job.lines[1].directives).toEqual([{ type: "CUT", mode: "PARTIAL" }]);
	});

	it("resolves styles onto each span rather than leaving a tag stack", () => {
		// Two short elements rather than one nested string, because the fixture's line limit is
		// twenty characters and the point being made is about the output, not the input.
		const job = run({ data: ["<size=2>x</size>", "<bold>y</bold>"] });

		expect(job.lines[0].spans[0].widthMult).toBe(2);
		expect(job.lines[0].spans[0].heightMult).toBe(2);
		expect(job.lines[1].spans[0].bold).toBe(true);
	});

	it("does not count directive-only lines as printed lines", () => {
		// A cut emits its command without advancing the paper, so it must not count against the
		// output limit or be reported as a printed line.
		const job = run({ data: ["one", "<cut>"] });

		expect(job.lines).toHaveLength(2);
		expect(
			countTextLines([{ align: "LEFT", wrap: null, spans: [], directives: [{ kind: "CUT", mode: "FULL" }] }]),
		).toBe(0);
	});

	it("compiles an empty data array", () => {
		const job = run({ data: [] });

		expect(job.lines).toHaveLength(0);
		expect(compiledJobSchema.safeParse(job).success).toBe(true);
	});

	describe("per-line wrapping", () => {
		// The shared limits allow twenty characters per element, which a tagged line exceeds
		// before it ever reaches the wrapper. Roomier here so the tag is what is being tested.
		const roomy: CompileLimits = { maxLines: 5, maxLineChars: 60, maxTotalChars: 200, maxOutputLines: 6 };

		/** Compiles against the ten-column fixture, with the device default under test. */
		const wrapping = (body: unknown, defaultWrap = true) => {
			const merged = { ...settings, defaultWrap };
			return compile("job", "kitchen", readRequest(body, roomy, merged), roomy, merged);
		};

		it("leaves a <nowrap> line intact while its neighbours wrap", () => {
			// At width 10, "ab ab ab ab" wraps to two lines; the tagged twin stays one.
			const job = wrapping({ data: ["ab ab ab ab", "<nowrap>ab ab ab ab</nowrap>"] });

			expect(job.lines).toHaveLength(3);
		});

		it("wraps a <wrap> line when the device default is off", () => {
			const job = wrapping({ data: ["<wrap>ab ab ab ab</wrap>"] }, false);

			expect(job.lines).toHaveLength(2);
		});

		it("follows the device default when no tag is present", () => {
			expect(wrapping({ data: ["ab ab ab ab"] }, false).lines).toHaveLength(1);
			expect(wrapping({ data: ["ab ab ab ab"] }, true).lines).toHaveLength(2);
		});

		it("counts lines produced by a tag against the output limit", () => {
			const tight: CompileLimits = { ...roomy, maxOutputLines: 1 };
			const merged = { ...settings, defaultWrap: false };

			expect(() =>
				compile("job", "kitchen", readRequest({ data: ["<wrap>ab ab ab ab</wrap>"] }, tight, merged), tight, merged),
			).toThrow(ApiError);
		});
	});

	describe("request fields", () => {
		it("rejects the removed wrap field and names its replacement", () => {
			const failure = error({ data: ["x"], wrap: false });

			expect(failure.code).toBe("unknown_field");
			expect(failure.message).toContain("<nowrap>");
		});

		it("rejects a misspelled field", () => {
			expect(error({ data: ["x"], linefeeed: "LF" }).code).toBe("unknown_field");
		});

		it("still accepts data and linefeed", () => {
			expect(() => run({ data: ["x"], linefeed: "CRLF" })).not.toThrow();
		});
	});
});
