import "server-only";

import { enumSetting, stringSetting } from "@/lib/settings/settings-service";
import type { Formatting, PrintContext, VariableLocale } from "@/lib/variables/evaluate";

/**
 * How this install renders a `DATETIME` variable, and what the panel stands in for a print's context.
 *
 * Both existed three times over before this module did: `lib/markup/resolve-variables.ts`,
 * `app/(panel)/variables/actions.ts` and `app/(panel)/tools/actions.ts` each carried their own copy
 * of the `system`-sentinel translation and their own literal `{ deviceName: "—", … }`. Three copies
 * of a rule is three chances for it to stop being one rule, and this one has a scheduled reason to
 * change: per-device timezone is a deferred item in this feature's own design, and when it lands
 * exactly one of those three call sites — the print path — is the one that must start reading the
 * device instead. Finding that site is much easier when the other two are visibly not it.
 *
 * `server-only`, because a settings read is a database read. That costs the panel actions nothing:
 * every caller is already a server action or a server component.
 */

/**
 * Resolves `variables.timezone` to an IANA zone.
 *
 * The `system` sentinel means the server's own zone, which `Intl` names for us. Translated here
 * rather than passed down, so `evaluateVariable` always receives a real zone and never has to know
 * the sentinel exists — the same translation `resolveTimeZone` does for the panel's formatter.
 *
 * @returns the zone to format printed dates in
 */
export async function printedTimeZone(): Promise<string> {
	const configured = await enumSetting<string>("variables.timezone");
	return configured === "system" ? Intl.DateTimeFormat().resolvedOptions().timeZone : configured;
}

/**
 * The zone and locale a `DATETIME` variable prints in.
 *
 * Deliberately separate from the panel's own `panel.timezone` and `panel.locale`: those are a
 * display preference for whoever is at the screen, these are what ends up on paper, possibly at a
 * site in another country.
 *
 * @returns the formatting to hand `evaluateVariable`
 */
export async function printedFormatting(): Promise<Formatting> {
	return {
		timeZone: await printedTimeZone(),
		locale: await enumSetting<VariableLocale>("variables.locale"),
	};
}

/**
 * Paper widths in millimetres, by printable column count.
 *
 * Only the two widths this system actually supports, and deliberately a lookup rather than
 * arithmetic: the relationship between columns and millimetres is a property of the printer's font
 * and head, not a formula, and a receipt printer configured to some third column count is not
 * evidence of a third paper size. An unrecognised count yields null, which prints as nothing —
 * better than confidently stating a width the paper does not have.
 */
const PAPER_WIDTH_MM: Readonly<Record<number, string>> = { 42: "80mm", 32: "58mm" };

/** The device and agent rows a print context is built from. */
export interface PrintTarget {
	name: string;
	columns: number;
	codepage: string;
	agent: { name: string; hostname: string | null; platform: string | null; agentVersion: string | null };
}

/**
 * Builds the context a `CONTEXT` variable reads for one real print.
 *
 * Shared by the print path and the API preview path so the two cannot disagree about what a receipt
 * says — a preview whose context differs from the print's is a preview that lies, and this feature
 * already shipped one such bug when the preview route dropped the API key it had just authenticated.
 *
 * @param target the device being printed to, with its agent
 * @param apiKeyName the key that submitted the job, or null when the panel did
 * @param idempotencyKey the caller’s own `Idempotency-Key` header, or null when they sent none
 * @returns the context to hand `resolveVariables`
 */
export async function printContextFor(
	target: PrintTarget,
	apiKeyName: string | null,
	idempotencyKey: string | null = null,
): Promise<PrintContext> {
	// Read rather than passed in: it is install-wide, so every caller would otherwise read it and
	// they would all read the same row. Empty means unset, which is a null here — `evaluateVariable`
	// renders that as nothing rather than as the word "null".
	const publicUrl = await stringSetting("server.publicUrl");

	return {
		deviceName: target.name,
		paperColumns: String(target.columns),
		paperWidth: PAPER_WIDTH_MM[target.columns] ?? null,
		codepage: target.codepage,
		agentName: target.agent.name,
		agentHostname: target.agent.hostname,
		agentPlatform: target.agent.platform,
		agentVersion: target.agent.agentVersion,
		apiKeyName,
		idempotencyKey,
		serverUrl: publicUrl.trim() === "" ? null : publicUrl,
	};
}

/**
 * The print context the panel evaluates a variable against when there is no print.
 *
 * The Variables table, the `DATETIME` dialog's live preview and the Tools tab's `{name}` picker all
 * show what a variable resolves to *right now*, with no printer chosen — so a device name, an agent
 * name and a key name are all things that genuinely do not exist yet. An em dash says that plainly
 * where a real name would go; `apiKeyName` is null rather than a dash because the null is not a
 * placeholder at all, it is the honest answer that no key submitted this, and `evaluateVariable`
 * renders it as an empty string exactly as it would for a print from the Tools page.
 *
 * Frozen, because it is shared: a caller that mutated it would change what every other panel surface
 * shows.
 */
export const PANEL_PRINT_CONTEXT: PrintContext = Object.freeze({
	deviceName: "—",
	paperColumns: null,
	paperWidth: null,
	codepage: null,
	agentName: "—",
	agentHostname: null,
	agentPlatform: null,
	agentVersion: null,
	apiKeyName: null,
	idempotencyKey: null,
	// Null rather than the configured address, even though this one *is* knowable without a printer.
	// Reading it would make this constant a database read, and the panel shows these values beside a
	// column already headed with an em dash for everything else a print would supply. One row quietly
	// resolving while its neighbours do not is more confusing than none of them resolving.
	serverUrl: null,
});
