import { nameSchema } from "@/lib/domain/naming";
import { ApiError } from "@/lib/errors";
import { hasControlCharacter } from "@/lib/variables/definition";

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
 * Reads and checks the values a request supplied.
 *
 * Runs with the rest of the body's limit checks, before any element is parsed and before any image
 * is fetched, so a malformed `variables` object is refused without costing a database round trip or
 * a network call.
 *
 * @param value the raw field from the parsed body
 * @param maxValueChars the install's cap on one value's length
 * @returns the supplied values, validated
 * @throws ApiError naming the first problem, and the name it is about
 */
export function readSuppliedVariables(value: unknown, maxValueChars: number): Record<string, string> {
	if (value === undefined || value === null) {
		return {};
	}
	// An array is an object to `typeof`, and `{"variables": ["a"]}` is a plausible enough mistake
	// that reading it as an empty map would be the wrong kindness.
	if (typeof value !== "object" || Array.isArray(value)) {
		throw new ApiError("invalid_type", "'variables' must be an object mapping names to string values");
	}

	const supplied: Record<string, string> = {};
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
		if (typeof raw !== "string") {
			throw new ApiError("invalid_type", `The value of variable '${name}' must be a string`);
		}
		if (raw.length > maxValueChars) {
			throw new ApiError(
				"variable_too_long",
				`The value of variable '${name}' must be at most ${maxValueChars} characters, got ${raw.length}`,
			);
		}
		// The parser checks this again at substitution, and that repetition is deliberate: this one
		// gives the caller a clear refusal naming the field, while that one is the boundary that has
		// to hold whatever reaches it.
		if (hasControlCharacter(raw)) {
			throw new ApiError(
				"invalid_variable_value",
				`The value of variable '${name}' contains a control character, which cannot be printed`,
			);
		}
		supplied[name] = raw;
	}
	return supplied;
}
