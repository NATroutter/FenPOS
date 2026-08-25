import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/errors";
import { compiledJobSchema } from "@/lib/link/protocol";
import { pdf417Columns, symbolGeometry } from "@/lib/markup/blocks";
import {
	type CompileLimits,
	type CompileSettings,
	collectElementErrors,
	compile,
	countOutputLines,
	countTextLines,
	readRequest,
} from "@/lib/markup/compiler";

/** The value-length cap `readRequest` enforces on a supplied `variables` field. Not itself under test here. */
const MAX_VARIABLE_VALUE_CHARS = 200;

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
		images: new Map(),
		variables: null,
	};

	const limits: CompileLimits = {
		maxLines: 5,
		maxLineChars: 20,
		maxTotalChars: 50,
		maxOutputLines: 3,
	};

	/** Runs a body through both stages, as a request handler does. */
	const run = (body: unknown) => {
		const request = readRequest(body, limits, settings, MAX_VARIABLE_VALUE_CHARS);
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
			countTextLines(
				[{ align: "LEFT", wrap: null, spans: [], fills: [], directives: [{ kind: "CUT", mode: "FULL" }] }],
				settings,
			),
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
			return compile("job", "kitchen", readRequest(body, roomy, merged, MAX_VARIABLE_VALUE_CHARS), roomy, merged);
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
				compile(
					"job",
					"kitchen",
					readRequest({ data: ["<wrap>ab ab ab ab</wrap>"] }, tight, merged, MAX_VARIABLE_VALUE_CHARS),
					tight,
					merged,
				),
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

	// -----------------------------------------------------------------------
	// Fills
	// -----------------------------------------------------------------------

	/** Flattens one compiled wire line back to the characters that would print. */
	const printed = (line: { spans: { text: string }[] }): string => line.spans.map((span) => span.text).join("");

	it("pads a fill to the device's width", () => {
		const job = run({ data: ["a<fill>b"] });

		expect(printed(job.lines[0])).toBe(`a${" ".repeat(8)}b`);
	});

	/**
	 * A filled line is exactly the paper's width, and the wrapper breaks on more than that, so it
	 * survives whole. Worth pinning: the property falls out of the wrapper rather than being stated
	 * anywhere, and `defaultWrap` is on in this fixture.
	 */
	it("does not wrap a line it filled", () => {
		const job = run({ data: ["a<fill>b"] });

		expect(job.lines).toHaveLength(1);
	});

	it("fills the same markup differently for a narrower device", () => {
		const request = readRequest({ data: ["a<fill>b"] }, limits, settings, MAX_VARIABLE_VALUE_CHARS);
		const narrow = compile("job-1", "kitchen", request, limits, { ...settings, columns: 6 });

		expect(printed(narrow.lines[0])).toBe(`a${" ".repeat(4)}b`);
	});

	/**
	 * A fill is a compile-time instruction with no wire representation, and that is enforced by
	 * construction: `toWireLine` builds each line from a fixed shape and the wire schema has no such
	 * field. So this pins the *wire's shape*, not fill resolution — it passes whether or not
	 * resolution ran. Its value is that a later `toWireLine` rewritten as a spread of the whole line
	 * fails here, rather than shipping the agent a field it has no idea what to do with.
	 */
	it("carries no fill across the wire", () => {
		const job = run({ data: ["a<fill>b"] });

		expect(compiledJobSchema.safeParse(job).success).toBe(true);
		expect(job.lines[0]).not.toHaveProperty("fills");
	});

	/**
	 * The preview collects every element's errors without a device in hand, so a fill character has
	 * to be checkable before the column count exists. That is why the charset pass runs first.
	 */
	it("reports an unprintable fill character with no column count in hand", () => {
		const errors = collectElementErrors(
			{ data: ["a<fill=€>b"], linefeed: "LF", variables: {} },
			{ ...settings, codepage: "CP437" },
			null,
		);

		expect(errors).toHaveLength(1);
		expect(errors[0].code).toBe("unsupported_character");
	});
});

/**
 * Coverage for the line budget's treatment of blocks and rules.
 *
 * The device fixture is identical to the one in "compile pipeline" above — ten columns, CP858 —
 * so a request accepted or measured there is accepted and measured the same way here.
 */
describe("block line budget", () => {
	/**
	 * Two images as the pre-pass resolves them, one stored and one remote.
	 *
	 * Ten columns is 120 dots, so the portrait logo is exactly the paper's width and twice its
	 * height — ten lines of 24 dots — and halving its width halves the paper it costs. Sizes chosen
	 * to divide evenly so the expected line counts below can be checked by eye rather than
	 * recomputed by the same arithmetic they are meant to be testing.
	 */
	const IMAGES = new Map([
		["logo", { width: 120, height: 240 }],
		["https://x.test/l.png?v=2", { width: 240, height: 120 }],
	]);

	const SETTINGS: CompileSettings = {
		columns: 10,
		codepage: "CP858",
		onUnsupported: "REJECT",
		defaultWrap: true,
		defaultLinefeed: "LF",
		images: IMAGES,
		variables: null,
	};

	/**
	 * The same device on 80mm paper, for the symbol cases.
	 *
	 * They need it now: a QR code is a couple of hundred dots wide and the ten-column paper above is
	 * 120, so the compiler refuses the symbol outright — which is a real property, tested in its own
	 * right below, but a different one from the height accounting these cases are about. The image
	 * cases stay on the narrow paper, where their arithmetic stays legible.
	 */
	const WIDE_SETTINGS: CompileSettings = { ...SETTINGS, columns: 42 };

	it("charges a QR code its printed height, not one line", () => {
		const plain = countOutputLines({ data: ["Hello"], linefeed: "LF", variables: {} }, WIDE_SETTINGS);
		const withQr = countOutputLines(
			{ data: ["Hello", "<qr>https://example.com/o/1</qr>"], linefeed: "LF", variables: {} },
			WIDE_SETTINGS,
		);
		expect(withQr - plain).toBeGreaterThan(1);
	});

	/**
	 * Nothing else in the system refuses this.
	 *
	 * A symbol wider than the print head prints with bars missing off the right edge, and a barcode
	 * with bars missing is not a narrower barcode — it is one that will not scan, found out by
	 * whoever is holding the receipt. It was left to the preview's over-wide marker until that
	 * marker turned out to be wrong for Code 128 and for ITF, so the refusal is here now, where it
	 * fails closed.
	 *
	 * Both sides of the boundary, and the message has to name the tag and the two widths: an error
	 * saying only "too wide" leaves the caller guessing which of several symbols and by how much.
	 */
	it("refuses a symbol wider than the device's paper, naming the tag and its column", () => {
		// Wrapped in an alignment so the tag is not at column 1, which is what shows the column
		// really travelled from the parser rather than being a constant the compiler made up.
		const element = "<align=center><qr=8>https://example.com/o/1</qr></align>";
		const thrown = (() => {
			try {
				countOutputLines({ data: ["Hello", element], linefeed: "LF", variables: {} }, SETTINGS);
				return null;
			} catch (error) {
				return error as ApiError;
			}
		})();

		expect(thrown).toBeInstanceOf(ApiError);
		expect(thrown?.code).toBe("symbol_too_wide");
		expect(thrown?.status).toBe(422);
		expect(thrown?.details).toMatchObject({ line: 2, column: element.indexOf("<qr=8>") + 1, detail: "qr" });
		expect(thrown?.message).toMatch(/200 dots wide, more than the 120/);

		// The same symbol on paper wide enough for it compiles, so this is the width and not the tag.
		expect(() => countOutputLines({ data: [element], linefeed: "LF", variables: {} }, WIDE_SETTINGS)).not.toThrow();
	});

	it("charges a drawer pulse nothing, because it prints nothing", () => {
		const plain = countOutputLines({ data: ["Hello"], linefeed: "LF", variables: {} }, SETTINGS);
		const withDrawer = countOutputLines({ data: ["Hello", "<drawer>"], linefeed: "LF", variables: {} }, SETTINGS);
		expect(withDrawer).toBe(plain);
	});

	it("charges a barcode and a PDF417 symbol exactly their measured height", () => {
		const plain = countOutputLines({ data: ["Hello"], linefeed: "LF", variables: {} }, WIDE_SETTINGS);

		const barcodeHeight = symbolGeometry({
			kind: "BARCODE",
			system: "EAN13",
			content: "1234567890128",
		}).heightLines;
		const withBarcode = countOutputLines(
			{ data: ["Hello", "<barcode=EAN13>1234567890128</barcode>"], linefeed: "LF", variables: {} },
			WIDE_SETTINGS,
		);
		expect(withBarcode - plain).toBe(barcodeHeight);

		const pdf417Height = symbolGeometry({ kind: "PDF417", content: "ORDER-1", errorLevel: 1 }).heightLines;
		const withPdf417 = countOutputLines(
			{ data: ["Hello", "<pdf417>ORDER-1</pdf417>"], linefeed: "LF", variables: {} },
			WIDE_SETTINGS,
		);
		expect(withPdf417 - plain).toBe(pdf417Height);
	});

	// A pre-existing bug: `<hr>` produces a RULE directive and no spans, so `isDirectiveOnly`
	// saw it as empty and charged it nothing, even though `toWireLine` expands it to a full line
	// of dashes that really prints. Fixed alongside the block accounting this describe block
	// exists to add, because leaving a known undercount inside the function being rewritten here
	// is worse than the small behaviour change of charging a rule what it actually costs.
	it("charges a rule one line, since it prints as a full line of dashes", () => {
		const plain = countOutputLines({ data: ["Hello"], linefeed: "LF", variables: {} }, SETTINGS);
		const withRule = countOutputLines({ data: ["Hello", "<hr>"], linefeed: "LF", variables: {} }, SETTINGS);
		expect(withRule - plain).toBe(1);
	});

	it("charges an image the paper its dots will cover", () => {
		// 120 dots wide, so 240 dots tall, which is ten lines of 24.
		expect(countOutputLines({ data: ["<image>logo</image>"], linefeed: "LF", variables: {} }, SETTINGS)).toBe(10);
	});

	it("charges a half-width image half the paper", () => {
		expect(countOutputLines({ data: ["<image=50>logo</image>"], linefeed: "LF", variables: {} }, SETTINGS)).toBe(5);
	});

	it("charges a URL image from its own dimensions, the same as a stored one", () => {
		// Landscape, so at full width it is half as tall as the paper is wide: 60 dots, three lines.
		expect(
			countOutputLines({ data: ["<image>https://x.test/l.png?v=2</image>"], linefeed: "LF", variables: {} }, SETTINGS),
		).toBe(3);
	});

	it("refuses a job whose images do not fit, the same as one whose text does not", () => {
		const limits: CompileLimits = { maxLines: 5, maxLineChars: 40, maxTotalChars: 100, maxOutputLines: 9 };
		const request = readRequest(
			{ data: ["<image>logo</image>"], linefeed: "LF" },
			limits,
			SETTINGS,
			MAX_VARIABLE_VALUE_CHARS,
		);

		expect(() => compile("job-1", "kitchen", request, limits, SETTINGS)).toThrow(ApiError);
	});

	/**
	 * An image that nobody resolved is a fault on this side, not a bad request: the pre-pass either
	 * produced its size or refused the whole job by name. Charging it nothing would be worse than
	 * failing, because the job would print an image the budget never counted.
	 */
	it("refuses to charge an image nobody resolved, rather than charging it nothing", () => {
		expect(() =>
			countOutputLines({ data: ["<image>missing</image>"], linefeed: "LF", variables: {} }, SETTINGS),
		).toThrow(/missing/);
	});

	it("charges a line carrying both text and a drawer pulse exactly one line", () => {
		const withText = countOutputLines({ data: ["Hello"], linefeed: "LF", variables: {} }, SETTINGS);
		const withTextAndDrawer = countOutputLines({ data: ["Hello<drawer>"], linefeed: "LF", variables: {} }, SETTINGS);
		expect(withTextAndDrawer).toBe(withText);
	});

	it("carries block directives to the wire unchanged, unlike a rule", () => {
		const limits: CompileLimits = { maxLines: 10, maxLineChars: 60, maxTotalChars: 400, maxOutputLines: 30 };
		const request = readRequest(
			{
				data: [
					"<qr=8>https://example.com/o/1</qr>",
					"<barcode=EAN13>1234567890128</barcode>",
					"<pdf417=4>ORDER-1</pdf417>",
					"<drawer=5>",
				],
				linefeed: "LF",
			},
			limits,
			WIDE_SETTINGS,
			MAX_VARIABLE_VALUE_CHARS,
		);
		const job = compile("job-1", "kitchen", request, limits, WIDE_SETTINGS);

		expect(job.lines[0].directives).toEqual([{ type: "QR", content: "https://example.com/o/1", size: 8 }]);
		expect(job.lines[1].directives).toEqual([{ type: "BARCODE", system: "EAN13", content: "1234567890128" }]);
		// `columns` is the exception to "unchanged": the symbol's layout is measured here and has to
		// travel, because the printer's own default is to choose one. See `directiveSchema`.
		expect(job.lines[2].directives).toEqual([
			{
				type: "PDF417",
				content: "ORDER-1",
				errorLevel: 4,
				columns: pdf417Columns(symbolGeometry({ kind: "PDF417", content: "ORDER-1", errorLevel: 4 }).widthDots),
			},
		]);
		expect(job.lines[3].directives).toEqual([{ type: "DRAWER", pin: 5 }]);
		expect(compiledJobSchema.safeParse(job).success).toBe(true);
	});
});

/**
 * How an image leaves the compiler, which is by one of two routes.
 *
 * A stored asset's dots reached the agent with its configuration, so the job names them. Anything
 * else — a URL, or a stored asset at a width nobody synced — has its dots put in the job. The
 * pre-pass decides which by whether it produced a raster; this is where that decision is read.
 */
describe("images on the wire", () => {
	/** A raster of the stated size, all paper, as the pre-pass would hand one over. */
	const raster = (widthDots: number, heightDots: number) => ({
		widthDots,
		heightDots,
		packed: Buffer.alloc(Math.ceil(widthDots / 8) * heightDots),
	});

	// Ten columns is 120 dots, which is the width the agent's rasters were synced at.
	const SETTINGS: CompileSettings = {
		columns: 10,
		codepage: "CP858",
		onUnsupported: "REJECT",
		defaultWrap: true,
		defaultLinefeed: "LF",
		images: new Map([
			// Stored: full width needs nothing in the job, half width does.
			["logo", { width: 120, height: 240, inline: new Map([[60, raster(60, 120)]]) }],
			// Stored, and nobody produced the half-width dots it would need.
			["stamp", { width: 120, height: 120, inline: new Map() }],
			// A URL, whose dots can never be pre-synced.
			["https://x.test/l.png", { width: 240, height: 120, inline: new Map([[120, raster(120, 60)]]) }],
		]),
		variables: null,
	};

	const limits: CompileLimits = { maxLines: 5, maxLineChars: 60, maxTotalChars: 200, maxOutputLines: 40 };

	const directivesFor = (element: string) => {
		const request = readRequest({ data: [element], linefeed: "LF" }, limits, SETTINGS, MAX_VARIABLE_VALUE_CHARS);
		const job = compile("job-1", "kitchen", request, limits, SETTINGS);
		expect(compiledJobSchema.safeParse(job).success).toBe(true);
		return job.lines[0].directives;
	};

	it("names a stored image at the paper's width, rather than sending its dots again", () => {
		expect(directivesFor("<image>logo</image>")).toEqual([
			{ type: "IMAGE", source: { kind: "REF", ref: "logo", widthDots: 120 } },
		]);
	});

	it("carries a URL image's dots inside the job, because nothing could have pre-synced them", () => {
		expect(directivesFor("<image>https://x.test/l.png</image>")).toEqual([
			{
				type: "IMAGE",
				source: { kind: "INLINE", widthDots: 120, heightDots: 60, data: Buffer.alloc(15 * 60).toString("base64") },
			},
		]);
	});

	/**
	 * Half a paper width is not a width any raster was synced at, and shrinking one that was would
	 * resample dots already reduced to black and white. So these dots ride in the job like a URL's.
	 */
	it("carries a stored image's dots when its printed width is not the one that was synced", () => {
		expect(directivesFor("<image=50>logo</image>")).toEqual([
			{
				type: "IMAGE",
				source: { kind: "INLINE", widthDots: 60, heightDots: 120, data: Buffer.alloc(8 * 120).toString("base64") },
			},
		]);
	});

	/**
	 * Naming a width the agent was never sent would produce a job that is accepted here and fails
	 * behind the printer, which is the failure this whole pipeline exists to avoid.
	 */
	it("refuses to name a width nobody synced, rather than sending a reference the agent cannot resolve", () => {
		expect(() => directivesFor("<image=50>stamp</image>")).toThrow(/stamp/);
	});
});

/**
 * Substitution inside the compile itself, once `settings.variables` carries a context.
 *
 * 42 columns rather than the ten-column fixture above: the wrapping case needs paper wide enough
 * that a substituted value's length, not some incidental tag, is what decides whether it wraps.
 */
describe("compiling with variables", () => {
	const limits = (): CompileLimits => ({
		maxLines: 5,
		maxLineChars: 200,
		maxTotalChars: 500,
		maxOutputLines: 10,
	});

	const settings = (): CompileSettings => ({
		columns: 42,
		codepage: "CP858",
		onUnsupported: "REJECT",
		defaultWrap: true,
		defaultLinefeed: "LF",
		images: new Map(),
		variables: null,
	});

	const withVariables = (entries: Record<string, string>): CompileSettings => ({
		...settings(),
		variables: { values: new Map(Object.entries(entries)), maxPerElement: 100 },
	});

	it("substitutes into a compiled line", () => {
		const job = compile(
			"j",
			"counter",
			{ data: ["Call {phone}"], linefeed: "LF", variables: {} },
			limits(),
			withVariables({ phone: "010" }),
		);

		expect(job.lines[0].spans.map((span) => span.text).join("")).toBe("Call 010");
	});

	it("leaves braces alone when the compile has no variable context", () => {
		const job = compile(
			"j",
			"counter",
			{ data: ["Call {phone}"], linefeed: "LF", variables: {} },
			limits(),
			settings(),
		);

		expect(job.lines[0].spans.map((span) => span.text).join("")).toBe("Call {phone}");
	});

	it("charges a substituted line the width it actually prints", () => {
		const long = "x".repeat(60);
		const job = compile(
			"j",
			"counter",
			{ data: ["{v}"], linefeed: "LF", variables: {} },
			limits(),
			withVariables({ v: long }),
		);

		// 60 characters across 42 columns wraps to two lines. If this is one, the wrapper ran before
		// substitution and the paper's width was measured against the wrong text.
		expect(job.lines).toHaveLength(2);
	});
});
