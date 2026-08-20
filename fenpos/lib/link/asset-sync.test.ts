import { readFileSync } from "node:fs";
import { Jimp, JimpMime } from "jimp";
import { beforeEach, describe, expect, it } from "vitest";
import { createAsset } from "@/lib/assets/asset-service";
import { prisma } from "@/lib/db";
import { rastersFor } from "@/lib/link/asset-sync";
import { type DeviceConfig, IMAGE_LIMITS, MAX_FRAME_BYTES, serialiseServerFrame } from "@/lib/link/protocol";

/**
 * Tests for which rasters an agent is sent with its configuration.
 *
 * Two properties are worth the file. The first is that the widths follow the agent's own devices —
 * one raster per image per *distinct* paper width — because that is what makes the common install
 * pay for one rather than for one per printer, and what stops a 58mm device being handed a picture
 * dithered for 80mm paper.
 *
 * The second is that nothing here can stop the device configuration reaching the agent. The frame
 * has a hard byte cap and is refused whole when it is exceeded, so an operator who uploads one
 * enormous image must not thereby unconfigure every printer in the shop.
 */

/** A real 128x40 PNG, the same fixture the dither and asset tests use. */
const PNG = readFileSync("test/fixtures/logo.png");

/**
 * A device of a given width in columns.
 *
 * Only `columns` matters here; the rest is a workable serial configuration so the fixture can be
 * measured as a real frame.
 */
function device(name: string, columns: number): DeviceConfig {
	return {
		name,
		port: "COM3",
		baudRate: 9600,
		dataBits: 8,
		stopBits: 1,
		parity: "NONE",
		flowControl: "NONE",
		writeTimeoutMs: 5000,
		autoConnect: true,
		autoReconnect: true,
		reconnectDelaySeconds: 5,
		columns,
		codepage: "CP858",
		paused: false,
		maxQueueDepth: 100,
	};
}

/**
 * A plain grey PNG of a given size.
 *
 * Grey rather than black or white so the dither produces a mixture of set and clear bits, which
 * keeps a byte-length assertion from passing on an all-zero buffer.
 *
 * @param width pixels across
 * @param height pixels down
 * @returns the encoded PNG
 */
async function solidPng(width: number, height: number): Promise<Buffer> {
	return Buffer.from(await new Jimp({ width, height, color: 0x808080ff }).getBuffer(JimpMime.png));
}

beforeEach(async () => {
	await prisma.asset.deleteMany();
});

describe("rastersFor", () => {
	it("sends one raster per image per distinct paper width", async () => {
		await createAsset("logo", PNG);

		// 42 columns is 504 dots and 32 is 384; the second 42-column device shares the first's raster.
		const rasters = await rastersFor([device("bar", 42), device("kitchen", 32), device("till", 42)], "agent-1");

		expect(rasters.map((raster) => raster.widthDots)).toEqual([384, 504]);
		expect(rasters.every((raster) => raster.name === "logo")).toBe(true);
	});

	it("sends a raster for every stored image, since any of them may be named", async () => {
		await createAsset("logo", PNG);
		await createAsset("stamp", PNG);

		const rasters = await rastersFor([device("kitchen", 32)], "agent-1");

		expect(rasters.map((raster) => raster.name)).toEqual(["logo", "stamp"]);
	});

	it("sends nothing for an agent with no devices, since no width would be right", async () => {
		await createAsset("logo", PNG);

		expect(await rastersFor([], "agent-1")).toEqual([]);
	});

	it("sends nothing when nothing is stored", async () => {
		expect(await rastersFor([device("kitchen", 32)], "agent-1")).toEqual([]);
	});

	/**
	 * The raster is the dots, at the width the device prints at. Asserted against the packed length
	 * rather than restated from the implementation's own arithmetic: a row is whole bytes wide, so a
	 * 384-dot raster is 48 bytes a row and its height follows from that.
	 */
	it("describes each raster by the rectangle its bits actually fill", async () => {
		await createAsset("logo", PNG);

		const [raster] = await rastersFor([device("kitchen", 32)], "agent-1");

		expect(raster.widthDots).toBe(384);
		expect(Buffer.from(raster.data, "base64").length).toBe(48 * raster.heightDots);
	});

	/**
	 * The frame is refused whole when a field is out of bounds, so an image the protocol will not
	 * carry has to cost only itself. Left to the frame, one tall picture would take every printer
	 * behind this agent out of configuration — which is why the entry is checked here.
	 *
	 * The tall image is 384 dots wide by 2200 tall, which is 48 bytes a row — 105,600 bytes of dots,
	 * past {@link IMAGE_LIMITS.maxRasterChars} once encoded. The small one beside it proves the
	 * refusal is of that image rather than of the sync.
	 */
	it("skips an image the frame will not carry, and still sends the ones it will", async () => {
		await createAsset("logo", PNG);
		await createAsset("tall", await solidPng(384, 2200));

		const rasters = await rastersFor([device("kitchen", 32)], "agent-1");

		expect(rasters.map((raster) => raster.name)).toEqual(["logo"]);
	});

	/**
	 * The result must always be sendable, whatever the device set costs. Two hundred and fifty-six
	 * devices with the longest port paths the schema permits is the worst case the frame can be asked
	 * to carry, and it leaves the least room for images.
	 */
	it("produces a frame within the cap even for the largest device set", async () => {
		await createAsset("logo", PNG);
		const crowded = Array.from({ length: 256 }, (_, index) => device(`device-${index}`, 42 + (index % 2))).map(
			(each) => ({ ...each, port: "x".repeat(256) }),
		);

		const frame = serialiseServerFrame({
			type: "config.sync",
			devices: crowded,
			assets: await rastersFor(crowded, "agent-1"),
		});

		expect(Buffer.byteLength(frame, "utf8")).toBeLessThanOrEqual(MAX_FRAME_BYTES);
	});

	it("stops at the count the frame permits, however many images are stored", async () => {
		for (let index = 0; index <= IMAGE_LIMITS.maxSyncedRasters; index++) {
			await createAsset(`logo-${index}`, PNG);
		}

		const rasters = await rastersFor([device("kitchen", 32)], "agent-1");

		expect(rasters.length).toBe(IMAGE_LIMITS.maxSyncedRasters);
	});
});
