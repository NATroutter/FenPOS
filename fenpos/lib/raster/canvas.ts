import type { ImageRaster } from "@/lib/assets/dither";

export type Pattern = "solid" | "hatch" | "dot" | "light" | "dark";

const BAYER = [
	[0, 8, 2, 10],
	[12, 4, 14, 6],
	[3, 11, 1, 9],
	[15, 7, 13, 5],
] as const;

/** Whether the dot at (x, y) is inked under a pattern. Anchored to the canvas so adjacent fills tile. */
export function patternDot(pattern: Pattern, x: number, y: number): boolean {
	switch (pattern) {
		case "solid":
			return true;
		case "hatch":
			return (x + y) % 4 === 0;
		case "dot":
			return x % 2 === 0 && y % 2 === 0;
		case "light":
			return BAYER[y & 3][x & 3] < 4;
		case "dark":
			return BAYER[y & 3][x & 3] < 12;
	}
}

/**
 * A one-bit drawing surface laid out exactly as `GS v 0` wants it.
 *
 * Painting is synchronous and allocation-free after construction, so `compile` stays a pure
 * function. Every primitive clips: drawing off the edge is the common case at a border, and a
 * bounds check per dot is cheaper than every caller reasoning about edges.
 */
export class Canvas {
	readonly rowBytes: number;
	readonly bits: Uint8Array;

	constructor(
		readonly width: number,
		readonly height: number,
	) {
		if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
			throw new RangeError(`a canvas needs a positive size, not ${width}x${height}`);
		}
		this.rowBytes = Math.ceil(width / 8);
		this.bits = new Uint8Array(this.rowBytes * height);
	}

	static fromRaster(raster: ImageRaster): Canvas {
		const canvas = new Canvas(raster.widthDots, raster.heightDots);
		canvas.bits.set(raster.packed.subarray(0, canvas.bits.length));
		return canvas;
	}

	get(x: number, y: number): boolean {
		if (x < 0 || y < 0 || x >= this.width || y >= this.height) return false;
		return (this.bits[y * this.rowBytes + (x >> 3)] & (0x80 >> (x & 7))) !== 0;
	}

	set(x: number, y: number): void {
		if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
		this.bits[y * this.rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
	}

	clear(x: number, y: number): void {
		if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
		this.bits[y * this.rowBytes + (x >> 3)] &= ~(0x80 >> (x & 7));
	}

	hLine(x: number, y: number, length: number, thickness = 1): void {
		for (let dy = 0; dy < thickness; dy++) {
			for (let dx = 0; dx < length; dx++) this.set(x + dx, y + dy);
		}
	}

	vLine(x: number, y: number, length: number, thickness = 1): void {
		for (let dx = 0; dx < thickness; dx++) {
			for (let dy = 0; dy < length; dy++) this.set(x + dx, y + dy);
		}
	}

	/**
	 * Draws the thinnest line joining two dots.
	 *
	 * Bresenham rather than a walk along the slope: a printer has no grey to spare, so a diagonal is
	 * one inked dot per step and which dot that is has to be decided in integers, or a line drawn
	 * twice from opposite ends would not land on the same dots.
	 */
	line(x0: number, y0: number, x1: number, y1: number): void {
		const dx = Math.abs(x1 - x0);
		const dy = -Math.abs(y1 - y0);
		const stepX = x0 < x1 ? 1 : -1;
		const stepY = y0 < y1 ? 1 : -1;
		let error = dx + dy;
		let x = x0;
		let y = y0;

		for (;;) {
			this.set(x, y);
			if (x === x1 && y === y1) return;
			const doubled = 2 * error;
			if (doubled >= dy) {
				error += dy;
				x += stepX;
			}
			if (doubled <= dx) {
				error += dx;
				y += stepY;
			}
		}
	}

	rect(x: number, y: number, width: number, height: number, thickness = 1): void {
		this.hLine(x, y, width, thickness);
		this.hLine(x, y + height - thickness, width, thickness);
		this.vLine(x, y, height, thickness);
		this.vLine(x + width - thickness, y, height, thickness);
	}

	fill(x: number, y: number, width: number, height: number, pattern: Pattern): void {
		for (let py = y; py < y + height; py++) {
			for (let px = x; px < x + width; px++) {
				if (patternDot(pattern, px, py)) this.set(px, py);
			}
		}
	}

	invert(x: number, y: number, width: number, height: number): void {
		for (let py = y; py < y + height; py++) {
			for (let px = x; px < x + width; px++) {
				if (this.get(px, py)) this.clear(px, py);
				else this.set(px, py);
			}
		}
	}

	blit(source: Canvas | ImageRaster, x: number, y: number): void {
		const from = source instanceof Canvas ? source : Canvas.fromRaster(source);
		for (let sy = 0; sy < from.height; sy++) {
			for (let sx = 0; sx < from.width; sx++) {
				if (from.get(sx, sy)) this.set(x + sx, y + sy);
			}
		}
	}

	pack(): ImageRaster {
		return { widthDots: this.width, heightDots: this.height, packed: Buffer.from(this.bits) };
	}
}
