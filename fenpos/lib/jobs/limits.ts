import type { CompileLimits } from "@/lib/markup/compiler";

/**
 * A device's own overrides for the limits a compile applies, as stored on its row.
 *
 * Every field is nullable: null means this device inherits whatever the install-wide setting (or,
 * failing that, the built-in default) says, and only a non-null value narrows it.
 */
export interface DeviceLimitOverrides {
	maxLines: number | null;
	maxLineChars: number | null;
	maxTotalChars: number | null;
	maxOutputLines: number | null;
	maxBlockDepth: number | null;
	maxTableCells: number | null;
	maxSeriesPoints: number | null;
	maxRasterMb: number | null;
	maxFontHeight: number | null;
}

/**
 * Resolves the limits a compile applies to one device's job.
 *
 * Three layers, narrowest wins: a device override, then the install-wide setting, then the
 * built-in default. A device that overrides nothing follows the setting, and an install that
 * changes nothing follows the code — so improving a default improves it for everyone who never
 * touched it.
 *
 * @param device the device's own overrides, as stored on its row
 * @param installed the install-wide limits, already resolved against built-in defaults
 * @returns the limits to apply to this device's job
 */
export function effectiveLimits(device: DeviceLimitOverrides, installed: CompileLimits): CompileLimits {
	return {
		maxLines: device.maxLines ?? installed.maxLines,
		maxLineChars: device.maxLineChars ?? installed.maxLineChars,
		maxTotalChars: device.maxTotalChars ?? installed.maxTotalChars,
		maxOutputLines: device.maxOutputLines ?? installed.maxOutputLines,
		maxBlockDepth: device.maxBlockDepth ?? installed.maxBlockDepth,
		maxTableCells: device.maxTableCells ?? installed.maxTableCells,
		maxSeriesPoints: device.maxSeriesPoints ?? installed.maxSeriesPoints,
		maxRasterBytes: device.maxRasterMb !== null ? device.maxRasterMb * 1024 * 1024 : installed.maxRasterBytes,
		maxFontHeight: device.maxFontHeight ?? installed.maxFontHeight,
	};
}
