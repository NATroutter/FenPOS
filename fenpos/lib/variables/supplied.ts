import { z } from "zod";
import { nameSchema } from "@/lib/domain/naming";
import { ApiError } from "@/lib/errors";
import { datePatternSchema, hasControlCharacter, OffsetUnit, offsetAmountSchema } from "@/lib/variables/definition";

/**
 * Validates the `variables` field of a print request.
 *
 * A separate module from `resolve-variables.ts`, and the separation is structural rather than
 * tidiness. This is called by `readRequest` in `compiler.ts`, which is pure and synchronous by
 * design — the property that lets the preview and the print path share one compile. Putting this
 * beside `resolveVariables` would make `compiler.ts` import a `server-only` module that reads
 * Prisma, which would drag a database into every unit test of the compiler and quietly cost the
 * thing that file's header says it exists to protect.
 *
 * So: nothing here reads a setting, a row, or the clock. The value cap arrives as an argument,
 * because it is the one thing this needs that only the caller can know.
 */

/**
 * One value a request supplied.
 *
 * A `text` value is substituted exactly as it arrived — that is what a plain string in the body has
 * always meant, and it is why a caller cannot send a `STATIC` "kind": a string already is one.
 *
 * A `moment` is the one thing a caller could not previously express: the *shape* of a date, left for
 * this install to render in its own zone and locale. There is no `kind` field in the request for it
 * — the shape is the kind — because a `kind` field would invite the two cases that are deliberately
 * not offered: `STATIC`, which a string already covers, and `CONTEXT`, which reads facts about this
 * install's hardware that a caller is in no position to assert.
 */
export type SuppliedValue =
	| { kind: "text"; text: string }
	| {
			kind: "moment";
			/** A `date-fns` pattern, held to the same bound a stored one obeys. */
			pattern: string;
			/**
			 * How far to shift from the job's instant before formatting; null means "now".
			 *
			 * Nested rather than the flat `offsetAmount`/`offsetUnit` pair the database uses, because an
			 * amount without a unit is meaningless: nesting makes that state unrepresentable rather than
			 * merely refused. The single conversion to the flat pair happens in `resolveVariables`.
			 */
			offset: { amount: number; unit: OffsetUnit } | null;
	  };

/**
 * The object form of a supplied value.
 *
 * `.strict()` on both levels, and that is the load-bearing part rather than tidiness. A caller who
 * sends `timezone` or `locale` alongside the pattern is asking for something this feature exists to
 * refuse — a receipt whose dates are half in the shop's zone and half in the caller's — and a
 * non-strict object would accept the key, drop it, and print a date in a zone nobody asked for. The
 * same goes for a `kind` field, and for `source`: silently ignored, they would each read as
 * supported.
 */
const dynamicValueSchema = z
	.object({
		pattern: datePatternSchema,
		// `.nullish()` rather than `.optional()`: a JSON serialiser on the caller's side may well emit
		// `offset: null` for an absent optional rather than dropping the key, and null cannot mean
		// anything different from omission here — both mean "the instant the job compiles at". The
		// `?? null` below already normalises the two to one internal value, so accepting both spellings
		// costs nothing downstream.
		offset: z.object({ amount: offsetAmountSchema, unit: OffsetUnit.schema }).strict().nullish(),
	})
	.strict();

/**
 * Refuses a value longer than the install allows.
 *
 * Exported because a `moment`'s *rendered* text is measured against the same cap, and that happens in
 * `resolveVariables` — nothing here can render anything. It matters that the two share this: a
 * `date-fns` pattern may carry quoted literal text (`'……'`), so a pattern is a way to put arbitrary
 * characters on paper, and a cap applied only to strings would be bypassed by sending an object.
 *
 * @param name the variable the value belongs to, for the message
 * @param text the value, or the text a value rendered to
 * @param maxValueChars the install's cap
 * @throws ApiError when it is too long
 */
export function requireValueWithinCap(name: string, text: string, maxValueChars: number): void {
	if (text.length > maxValueChars) {
		throw new ApiError(
			"variable_too_long",
			`The value of variable '${name}' must be at most ${maxValueChars} characters, got ${text.length}`,
		);
	}
}

/**
 * Reads and checks the values a request supplied.
 *
 * Runs with the rest of the body's limit checks, before any element is parsed and before any image
 * is fetched, so a malformed `variables` object is refused without costing a database round trip or
 * a network call.
 *
 * @param value the raw field from the parsed body
 * @param maxValueChars the install's cap on one value's length
 * @returns the supplied values, validated — literal text, or a date for `resolveVariables` to render
 * @throws ApiError naming the first problem, and the name it is about
 */
export function readSuppliedVariables(value: unknown, maxValueChars: number): Record<string, SuppliedValue> {
	if (value === undefined || value === null) {
		return {};
	}
	// An array is an object to `typeof`, and `{"variables": ["a"]}` is a plausible enough mistake
	// that reading it as an empty map would be the wrong kindness.
	if (typeof value !== "object" || Array.isArray(value)) {
		throw new ApiError("invalid_type", "'variables' must be an object mapping names to values");
	}

	const supplied: Record<string, SuppliedValue> = {};
	for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
		// `nameSchema`, not `VARIABLE_REFERENCE`. The regex is anchored only at its start, because the
		// parser uses it to test the position it is standing on — so `VARIABLE_REFERENCE.test("{a}x}")`
		// is true, and a name of `a}x` would sail through a check built that way while being
		// unreferenceable from markup. The schema matches the whole string, which is the question
		// actually being asked here.
		if (!nameSchema.safeParse(name).success) {
			throw new ApiError(
				"invalid_variable_name",
				`'${name}' is not a valid variable name; use lowercase letters, numbers, dashes and underscores, starting with a letter or number`,
			);
		}

		if (typeof raw === "string") {
			requireValueWithinCap(name, raw, maxValueChars);
			// The parser checks this again at substitution, and that repetition is deliberate: this one
			// gives the caller a clear refusal naming the field, while that one is the boundary that has
			// to hold whatever reaches it.
			if (hasControlCharacter(raw)) {
				throw new ApiError(
					"invalid_variable_value",
					`The value of variable '${name}' contains a control character, which cannot be printed`,
				);
			}
			supplied[name] = { kind: "text", text: raw };
			continue;
		}

		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
			throw new ApiError(
				"invalid_type",
				`The value of variable '${name}' must be a string, or an object describing a date to compute`,
			);
		}

		const parsed = dynamicValueSchema.safeParse(raw);
		if (!parsed.success) {
			// `invalid_variable`, the same code a definition the panel refuses gets, and deliberately
			// the same code an unrenderable pattern gets in `resolveVariables`: from the caller's side
			// those are one problem — the definition they sent is not one this server can use — and the
			// message carries which.
			//
			// The field path is interpolated alongside the message because every other refusal in this
			// function names the exact field at fault, and `issues[0].path` is populated in every case
			// this schema can fail — a missing `pattern`, an unknown key, a fractional `offset.amount` —
			// so leaving it out was the odd one out rather than a saving.
			const issue = parsed.error.issues[0];
			throw new ApiError(
				"invalid_variable",
				`The value of variable '${name}' is not a date this server can compute: ${
					issue ? `${issue.path.join(".")}: ${issue.message}` : "that shape is not valid."
				}`,
			);
		}

		// The parser catches a control character inside a `'…'` literal too, but only at substitution
		// — which on the print path is after the job row exists, unlike the text branch above, which
		// refuses one before anything is written. Checking here closes that asymmetry: a `moment` value
		// is refused at the same boundary a `text` value is, with the same code. A `date-fns` token
		// expands from locale data, never from caller input, so the literal segments a pattern carries
		// are the only place a control character could come from, and checking the pattern as written is
		// enough — nothing rendered from it needs checking separately.
		if (hasControlCharacter(parsed.data.pattern)) {
			throw new ApiError(
				"invalid_variable_value",
				`The pattern of variable '${name}' contains a control character, which cannot be printed`,
			);
		}

		// The rendered length is *not* checked here. Nothing in this module may read a clock, so the
		// text that would print does not exist yet; `resolveVariables` measures it once it does.
		supplied[name] = { kind: "moment", pattern: parsed.data.pattern, offset: parsed.data.offset ?? null };
	}
	return supplied;
}
