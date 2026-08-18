import { z } from "zod";

/**
 * Naming rules for agents and devices.
 *
 * Both appear as path segments in the public API (`/api/print/{agent}/{device}`), in log
 * lines, and in the link protocol. Constraining the character set once here means no
 * consumer has to escape them — which is a far smaller surface than remembering to escape
 * correctly in every place they are interpolated.
 *
 * The format is a slug rather than free text. That is a deliberate trade: an operator types
 * `kitchen` rather than `Kitchen Printer #2`, and in exchange the name is safe everywhere and
 * reads the same in a URL, a receipt log, and a terminal.
 */

/** Longest permitted name. Bounded because names are indexed and displayed in fixed layouts. */
export const MAX_NAME_LENGTH = 64;

/**
 * Slug pattern: lowercase alphanumeric, with dashes or underscores after the first character.
 *
 * A leading dash or underscore is excluded so a name cannot be mistaken for a flag when it
 * appears as a command-line argument on the agent.
 */
export const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/** Validates a agent or device name. */
export const nameSchema = z
	.string()
	.min(1, "Name is required.")
	.max(MAX_NAME_LENGTH, `Name must be at most ${MAX_NAME_LENGTH} characters.`)
	.regex(NAME_PATTERN, "Use lowercase letters, numbers, dashes and underscores; start with a letter or number.");

/**
 * Converts a human-typed label into a candidate name.
 *
 * Offered as a convenience when creating a agent, so an operator who types "Kitchen Printer"
 * gets `kitchen-printer` rather than a validation error. The result is still validated: this
 * suggests, it does not bypass.
 *
 * @param input free text as typed
 * @param options `keepTrailingSeparator` retains a trailing dash, for live input
 * @returns a slug candidate, which may still be empty and must be validated
 */
export function toNameCandidate(input: string, options: { keepTrailingSeparator?: boolean } = {}): string {
	const slug = input
		.normalize("NFKD")
		// Strip diacritics so "Kahvila" and "Kahvilä" do not become different names.
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+/, "");

	// Trimming the trailing dash is wrong while the operator is still typing: "Kitchen "
	// normalises to "kitchen", and the next keystroke then yields "kitchenp" rather than
	// "kitchen-p" — the word boundary is destroyed before the word is finished. Callers
	// normalising live input keep the separator; the final trim happens on submission.
	const trimmed = options.keepTrailingSeparator ? slug : slug.replace(/-+$/, "");

	return trimmed.slice(0, MAX_NAME_LENGTH);
}
