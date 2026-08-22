/**
 * Byte-count formatting shared between the server and the browser.
 *
 * Plain — no `server-only` guard — because `describeBytes` below is read by a client component
 * (`upload-dialog.tsx`) as well as by server code, and `server-only` throws the moment a client
 * bundle pulls in a module carrying it.
 */

/**
 * States a byte count in whichever of KiB or MiB reads better.
 *
 * **Every caller, both halves of every sentence.** `describeBytes` exists because a megabytes-only
 * formatter floors a small refusal — a truncated file of a few hundred bytes, say — to "0 MB", the
 * exact number an operator needs after a refusal turned into the one number that tells them
 * nothing. That protection is void the moment only half of a refusal routes through it: "That
 * image is 0.6 MB. The limit is 1 MiB." is two different unit scales in one sentence, which is its
 * own kind of confusing even though neither half is wrong on its own. Every size shown to a
 * person — the cap and the file that tripped it alike — must come from this function so the
 * sentence agrees with itself.
 *
 * **KiB and MiB, not KB and MB.** The arithmetic below is 1024-based, so those are the true units,
 * and `assets.maxUploadMb`'s own name and its `unit: "MiB"` already commit to binary units — a
 * value that reads "1 MiB" on the Settings page must read the same way wherever else it appears,
 * and matching the label is one edit here rather than relabelling the setting and changing what a
 * stored 1 means.
 *
 * Floors within whichever unit it picks, matching how a byte cap has always been stated here: a
 * refusal that rounded up would tell someone a slightly larger file fits than actually does. One
 * decimal place within the chosen unit, so a size well under the next unit up — a 1.6 MiB file
 * refused by a 1 MiB cap — still reads as a number rather than always rounding to a whole unit.
 *
 * @param bytes the count to state
 * @returns e.g. `"256 KiB"`, `"1.5 KiB"`, or `"8 MiB"`
 */
export function describeBytes(bytes: number): string {
	if (bytes >= 1024 * 1024) {
		return `${round(bytes / 1024 / 1024)} MiB`;
	}
	return `${round(bytes / 1024)} KiB`;
}

/**
 * Floors to one decimal place, within whichever unit {@link describeBytes} has already chosen.
 *
 * A plain `toFixed(1)` would round `0.999...` up to `"1.0"` and silently overstate what a byte
 * count says fits; flooring first keeps the displayed figure from ever claiming more room than the
 * bytes actually are. Whole numbers still print without a trailing `.0` — `256`, not `256.0` — to
 * match how this module has always stated a round figure.
 *
 * @param value the quantity, already divided into its chosen unit
 * @returns the value floored to one decimal place, without a trailing `.0`
 */
function round(value: number): string {
	const floored = Math.floor(value * 10) / 10;
	return Number.isInteger(floored) ? String(floored) : floored.toFixed(1);
}
