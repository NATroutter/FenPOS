/**
 * Byte-count formatting shared between the server and the browser.
 *
 * Plain — no `server-only` guard — because `describeBytes` below is read by a client component
 * (`upload-dialog.tsx`) as well as by server code, and `server-only` throws the moment a client
 * bundle pulls in a module carrying it.
 */

/**
 * States a byte count in whichever of KB or MB reads better.
 *
 * `assets.maxUploadKb` can be set as low as 256 KiB, which a megabytes-only formatter floors to
 * "0 MB" — the exact number an operator needs after a refusal, turned into the one number that
 * tells them nothing. Switching units below one megabyte is what keeps the figure meaningful across
 * the setting's whole range, from a quarter-megabyte logo cap to an eight-megabyte photograph one.
 *
 * Floors within whichever unit it picks, matching how a byte cap has always been stated here: a
 * refusal that rounded up would tell someone a slightly larger file fits than actually does.
 *
 * @param bytes the count to state
 * @returns e.g. `"256 KB"` or `"8 MB"`
 */
export function describeBytes(bytes: number): string {
	if (bytes >= 1024 * 1024) {
		return `${Math.floor(bytes / 1024 / 1024)} MB`;
	}
	return `${Math.floor(bytes / 1024)} KB`;
}
