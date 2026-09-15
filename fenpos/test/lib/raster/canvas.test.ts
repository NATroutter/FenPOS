import { describe, expect, it } from "vitest";
import { rasterBytes } from "@/lib/link/protocol";
import { Canvas, patternDot } from "@/lib/raster/canvas";
import { ascii } from "../../helpers/pbm";

describe("Canvas", () => {
	it("packs one bit per dot, MSB first, rows padded to a byte", () => {
		const canvas = new Canvas(10, 2);
		canvas.set(0, 0);
		canvas.set(9, 1);

		const raster = canvas.pack();

		expect(raster.widthDots).toBe(10);
		expect(raster.heightDots).toBe(2);
		expect(raster.packed.length).toBe(rasterBytes(10, 2));
		expect([...raster.packed]).toEqual([0b10000000, 0b00000000, 0b00000000, 0b01000000]);
	});

	it("ignores dots outside its bounds", () => {
		const canvas = new Canvas(4, 4);
		canvas.set(-1, 0);
		canvas.set(4, 0);
		canvas.set(0, 4);

		expect([...canvas.pack().packed]).toEqual([0, 0, 0, 0]);
		expect(canvas.get(-1, 0)).toBe(false);
	});

	it("draws lines and outlines inside the rectangle", () => {
		const canvas = new Canvas(6, 4);
		canvas.rect(0, 0, 6, 4);

		expect(ascii(canvas.pack())).toBe(["######", "#....#", "#....#", "######"].join("\n"));
	});

	it("draws a thick outline inward", () => {
		const canvas = new Canvas(6, 5);
		canvas.rect(0, 0, 6, 5, 2);

		expect(ascii(canvas.pack())).toBe(["######", "######", "##..##", "######", "######"].join("\n"));
	});

	it("draws a sloped line between its two ends", () => {
		const canvas = new Canvas(6, 3);
		canvas.line(0, 0, 5, 2);

		expect(ascii(canvas.pack())).toBe(["##....", "..##..", "....##"].join("\n"));
	});

	it("draws a line whichever way round its ends are given", () => {
		const forward = new Canvas(5, 5);
		forward.line(0, 4, 4, 0);
		const backward = new Canvas(5, 5);
		backward.line(4, 0, 0, 4);

		expect(ascii(backward.pack())).toBe(ascii(forward.pack()));
		expect(ascii(forward.pack())).toBe(["....#", "...#.", "..#..", ".#...", "#...."].join("\n"));
	});

	it("draws a line of one dot when both ends are the same", () => {
		const canvas = new Canvas(3, 1);
		canvas.line(1, 0, 1, 0);

		expect(ascii(canvas.pack())).toBe(".#.");
	});

	it("fills with a pattern anchored to canvas coordinates", () => {
		const canvas = new Canvas(8, 4);
		canvas.fill(0, 0, 8, 4, "dot");

		expect(ascii(canvas.pack())).toBe(["#.#.#.#.", "........", "#.#.#.#.", "........"].join("\n"));
	});

	it("inverts a rectangle", () => {
		const canvas = new Canvas(4, 1);
		canvas.set(0, 0);
		canvas.invert(0, 0, 4, 1);

		expect(ascii(canvas.pack())).toBe(".###");
	});

	it("blits a raster clipped at the edge", () => {
		const stamp = new Canvas(3, 1);
		stamp.fill(0, 0, 3, 1, "solid");
		const canvas = new Canvas(4, 1);
		canvas.blit(stamp.pack(), 2, 0);

		expect(ascii(canvas.pack())).toBe("..##");
	});

	it("round-trips through fromRaster", () => {
		const canvas = new Canvas(13, 3);
		canvas.hLine(0, 1, 13);

		expect(ascii(Canvas.fromRaster(canvas.pack()).pack())).toBe(ascii(canvas.pack()));
	});

	it("refuses an empty canvas", () => {
		expect(() => new Canvas(0, 1)).toThrow(RangeError);
	});
});

describe("patternDot", () => {
	it("makes light sparser than dark", () => {
		const count = (pattern: "light" | "dark"): number => {
			let dots = 0;
			for (let y = 0; y < 8; y++) {
				for (let x = 0; x < 8; x++) {
					if (patternDot(pattern, x, y)) dots += 1;
				}
			}
			return dots;
		};
		expect(count("light")).toBe(16);
		expect(count("dark")).toBe(48);
	});
});
