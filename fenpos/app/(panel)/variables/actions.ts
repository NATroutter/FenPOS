"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/app/(panel)/agents/action-state";
import { requireSession } from "@/lib/auth/require-session";
import { ApiError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { enumSetting } from "@/lib/settings/settings-service";
import type { OffsetUnit, VariableDefinition } from "@/lib/variables/definition";
import { evaluateVariable, type Formatting, type VariableLocale } from "@/lib/variables/evaluate";
import { createVariable, deleteVariable, updateVariable } from "@/lib/variables/variable-service";

/**
 * Server actions behind the Variables tab.
 *
 * Every action re-checks the session. The panel layout already guards the page, but an action is a
 * POST endpoint in its own right: anything that trusted the layout would be callable directly by
 * anyone who knew the action id.
 */

async function run(label: string, work: () => Promise<void>): Promise<ActionState> {
	await requireSession();

	try {
		await work();
		revalidatePath("/variables");
		return { error: null };
	} catch (error) {
		if (error instanceof ApiError) {
			return { error: error.message };
		}
		logger.error(`Variable action failed: ${label}`, error);
		return { error: "Something went wrong. Check the server log." };
	}
}

/**
 * Creates or replaces a variable.
 *
 * One action for both because the dialog is one form: whether it is editing depends only on whether
 * it was opened on a row, and splitting this in two would mean the same fields validated by two
 * paths that could drift.
 *
 * @param id the variable to replace, or null to create one
 * @param input the definition
 * @returns the state to render
 */
export async function saveVariable(id: string | null, input: VariableDefinition): Promise<ActionState> {
	return run("save", async () => {
		if (id === null) {
			await createVariable(input);
		} else {
			await updateVariable(id, input);
		}
	});
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
	return run("remove", () => deleteVariable(id));
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
 * here the way it is in {@link saveVariable} — there is simply nothing yet to show.
 *
 * The synthetic context mirrors the one the Variables page resolves the table against — a printer
 * name of "—" rather than a real device, because a pattern preview has no printer in mind and a
 * `DATETIME` variable never reads the context anyway.
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
	await requireSession();

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
		const formatting: Formatting = {
			timeZone: await printedTimeZone(),
			locale: await enumSetting<VariableLocale>("variables.locale"),
		};
		const text = evaluateVariable(
			definition,
			new Date(),
			{ deviceName: "—", agentName: "—", apiKeyName: null },
			formatting,
		);
		return { text, error: null };
	} catch (error) {
		// `evaluateVariable` throws a message naming the variable when `date-fns` refuses the
		// pattern — `YYYY` and `DD` are the common mistakes for `yyyy` and `dd`. That message is
		// exactly what the operator needs to see while they are still typing it.
		return { text: null, error: error instanceof Error ? error.message : "That pattern could not be formatted." };
	}
}

/**
 * Resolves `variables.timezone` to an IANA zone.
 *
 * A small copy of `printedTimeZone` in `lib/markup/resolve-variables.ts`, which is not exported —
 * that module resolves a real job's variables and this one is rendering a preview for a form that
 * has not been saved yet, so duplicating three lines here keeps the two call sites from having to
 * share a dependency neither otherwise needs.
 *
 * @returns the zone to format printed dates in
 */
async function printedTimeZone(): Promise<string> {
	const configured = await enumSetting<string>("variables.timezone");
	return configured === "system" ? Intl.DateTimeFormat().resolvedOptions().timeZone : configured;
}
