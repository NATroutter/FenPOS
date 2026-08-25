"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/app/(panel)/agents/action-state";
import { panelAction, panelQuery } from "@/lib/auth/panel-action";
import { REFUSAL_MESSAGE } from "@/lib/auth/require-permission";
import type { OffsetUnit, VariableDefinition } from "@/lib/variables/definition";
import { evaluateVariable } from "@/lib/variables/evaluate";
import { PANEL_PRINT_CONTEXT, printedFormatting } from "@/lib/variables/formatting";
import {
	createVariable as createVariableRecord,
	deleteVariable,
	updateVariable as updateVariableRecord,
} from "@/lib/variables/variable-service";

/**
 * Server actions behind the Variables tab.
 *
 * Every action goes through the shared gate, which resolves the session, checks the permission its
 * registry entry names, runs the body, and records the attempt.
 */

/** What every action here refreshes on success. */
const revalidate = () => revalidatePath("/variables");

/**
 * Creates a variable.
 *
 * Split from the update path, which was one action branching on whether `id` was null. One action
 * with two meanings cannot carry one permission, and the permission is what the panel is gated on,
 * so the action is split rather than the rule bent. The dialog is still one form: it decides which
 * of these to call from the same state it used to decide what to pass as `id`.
 *
 * @param input the definition
 * @returns the state to render
 */
export async function createVariable(input: VariableDefinition): Promise<ActionState> {
	return panelAction(
		"variables:create",
		async () => {
			await createVariableRecord(input);
		},
		// The name and kind; never the value. A static variable's value is whatever an operator typed
		// and often the shop's own phone number or address.
		{ revalidate, target: { kind: "variable", label: input.name }, detail: { kind: input.kind } },
	);
}

/**
 * Replaces a variable's definition.
 *
 * @param id the variable to replace
 * @param input the new definition
 * @returns the state to render
 */
export async function updateVariable(id: string, input: VariableDefinition): Promise<ActionState> {
	return panelAction(
		"variables:update",
		async () => {
			await updateVariableRecord(id, input);
		},
		{ revalidate, target: { kind: "variable", id, label: input.name }, detail: { kind: input.kind } },
	);
}

/**
 * Removes a variable.
 *
 * Receipts still naming it will fail to compile after this, which is the intended consequence of
 * refusing an unknown name rather than printing it. The dialog says so before it calls this.
 *
 * @param id the variable to remove
 * @returns the state to render
 */
export async function removeVariable(id: string): Promise<ActionState> {
	return panelAction("variables:delete", () => deleteVariable(id), {
		revalidate,
		target: { kind: "variable", id },
	});
}

/** What the dialog's live `DATETIME` preview renders. */
export interface MomentPreview {
	/** What the pattern prints right now, or null while nothing has been typed. */
	text: string | null;
	/** `date-fns`'s own complaint about the pattern, or null when it read fine. */
	error: string | null;
}

/**
 * Renders a `DATETIME` pattern against the current instant, for the dialog's live preview.
 *
 * A server action rather than something the dialog computes itself: `evaluateVariable` needs the
 * install's configured zone and locale, which are settings, and an empty pattern is not an error
 * here the way it is in {@link createVariable} — there is simply nothing yet to show.
 *
 * The synthetic context is the one every panel surface shares — see `PANEL_PRINT_CONTEXT` — a
 * printer name of "—" rather than a real device, because a pattern preview has no printer in mind
 * and a `DATETIME` variable never reads the context anyway.
 *
 * @param pattern the candidate `date-fns` pattern, as typed so far
 * @param offsetAmount the offset to apply before formatting, or null for none
 * @param offsetUnit the unit that offset is counted in, or null when there is no offset
 * @returns the rendered text, or the message naming why the pattern could not be read
 */
export async function previewMoment(
	pattern: string,
	offsetAmount: number | null,
	offsetUnit: OffsetUnit | null,
): Promise<MomentPreview> {
	return panelQuery<MomentPreview>("variables:preview", () => renderMoment(pattern, offsetAmount, offsetUnit), {
		refused: () => ({ text: null, error: REFUSAL_MESSAGE }),
		// A bad pattern is a result this action reports, not a failure of the action — it is caught
		// inside `renderMoment` and returned. Anything reaching here is something else entirely.
		failed: () => ({ text: null, error: "That pattern could not be formatted." }),
	});
}

/**
 * Renders the pattern, or says why it could not be.
 *
 * Split out of the action so the gate wraps one function rather than a body with two exits. An
 * empty pattern is not an error: there is simply nothing yet to show.
 *
 * @param pattern the candidate `date-fns` pattern, as typed so far
 * @param offsetAmount the offset to apply before formatting, or null for none
 * @param offsetUnit the unit that offset is counted in, or null when there is no offset
 * @returns the rendered text, or the message naming why the pattern could not be read
 */
async function renderMoment(
	pattern: string,
	offsetAmount: number | null,
	offsetUnit: OffsetUnit | null,
): Promise<MomentPreview> {
	if (pattern.trim() === "") {
		return { text: null, error: null };
	}

	const definition: VariableDefinition = {
		name: "preview",
		kind: "DATETIME",
		value: null,
		pattern,
		offsetAmount,
		offsetUnit,
		source: null,
		overridable: false,
		description: null,
	};

	try {
		const text = evaluateVariable(definition, new Date(), PANEL_PRINT_CONTEXT, await printedFormatting());
		return { text, error: null };
	} catch (error) {
		// `date-fns`'s own words are what the operator needs: `YYYY` and `DD` are the common mistakes
		// for `yyyy` and `dd`, and its message names the token and the replacement. The same throw is
		// what `requireValid` turns into a refusal on save, so this is not merely advice — a pattern
		// reported as an error here is one the dialog will not let through.
		//
		// Unwrapped to the `cause` rather than reported as thrown. `evaluateVariable` prefixes its
		// message with the variable's name, which is right when a receipt fails to print and the
		// operator has to work out *which* of their variables carries the bad pattern — but wrong
		// here, where the definition is a throwaway this function built a moment ago and named
		// `preview`. Reporting it verbatim put "Variable 'preview' has a pattern this system cannot
		// format" in front of an operator editing a variable called something else entirely.
		return { text: null, error: patternProblem(error) };
	}
}

/**
 * The part of a formatting failure worth showing beside the pattern field.
 *
 * @param error whatever `evaluateVariable` threw
 * @returns the underlying formatter's message, or a plain fallback
 */
function patternProblem(error: unknown): string {
	const cause = error instanceof Error ? error.cause : null;
	if (cause instanceof Error) {
		return cause.message;
	}
	return error instanceof Error ? error.message : "That pattern could not be formatted.";
}
