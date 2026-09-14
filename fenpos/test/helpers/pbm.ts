import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect } from "vitest";
import type { ImageRaster } from "@/lib/assets/dither";

const FIXTURES = path.join(process.cwd(), "test", "fixtures", "rasters");

export function toPbm(raster: ImageRaster): Buffer {
	return Buffer.concat([Buffer.from(`P4\n${raster.widthDots} ${raster.heightDots}\n`, "ascii"), raster.packed]);
}

export function fromPbm(bytes: Buffer): ImageRaster {
	const header = /^P4\n(\d+) (\d+)\n/.exec(bytes.subarray(0, 32).toString("ascii"));
	if (!header) throw new Error("not a P4 PBM");
	const widthDots = Number(header[1]);
	const heightDots = Number(header[2]);
	return { widthDots, heightDots, packed: Buffer.from(bytes.subarray(header[0].length)) };
}

export function ascii(raster: ImageRaster): string {
	const rowBytes = Math.ceil(raster.widthDots / 8);
	const rows: string[] = [];
	for (let y = 0; y < raster.heightDots; y++) {
		let row = "";
		for (let x = 0; x < raster.widthDots; x++) {
			row += (raster.packed[y * rowBytes + (x >> 3)] & (0x80 >> (x & 7))) !== 0 ? "#" : ".";
		}
		rows.push(row);
	}
	return rows.join("\n");
}

/**
 * Compares a raster dot for dot against a committed golden file.
 *
 * Set `UPDATE_RASTERS=1` to (re)write the golden and pass. Review the ASCII rendering in the
 * diff before committing a regenerated file.
 */
export function expectRasterToMatchGolden(raster: ImageRaster, name: string): void {
	const file = path.join(FIXTURES, `${name}.pbm`);
	if (process.env.UPDATE_RASTERS === "1" || !existsSync(file)) {
		mkdirSync(FIXTURES, { recursive: true });
		writeFileSync(file, toPbm(raster));
		writeFileSync(`${file}.txt`, ascii(raster));
		return;
	}
	const golden = fromPbm(readFileSync(file));
	expect(ascii(raster), `${name} differs from its golden raster`).toBe(ascii(golden));
}
