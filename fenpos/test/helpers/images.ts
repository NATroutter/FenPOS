import { Jimp, JimpMime } from "jimp";

/**
 * A real PNG of the given size, for tests that need bytes a decoder will accept.
 *
 * Encoded rather than hand-built, because the callers that want this want a file that gets *past*
 * the header checks and into the decoder. Tests about the order those checks run in want the
 * opposite and should reach for {@link pngHeaderClaiming} instead.
 *
 * @param width pixels across
 * @param height pixels down
 * @returns the encoded PNG
 */
export async function pngOf(width: number, height: number): Promise<Buffer> {
	return Buffer.from(await new Jimp({ width, height, color: 0xffffffff }).getBuffer(JimpMime.png));
}

/**
 * A real JPEG of the given stored size, carrying an EXIF orientation tag.
 *
 * What a phone produces: the sensor's own landscape bitmap, plus a tag saying how a viewer should
 * turn it. Orientation 6 is the common portrait case — a photo held upright is stored 4000x3000 and
 * tagged "rotate 90° clockwise", so everything that honours the tag sees 3000x4000.
 *
 * Built by splicing rather than by an EXIF library, because there is no encoder here that writes the
 * tag and the segment is small enough to state exactly. Immediately after SOI goes an APP1 segment:
 * the marker, a length, `Exif\0\0`, a big-endian TIFF header (`MM`, 0x002A, IFD0 at offset 8), and an
 * IFD holding one entry — tag 0x0112, type SHORT, count 1, the orientation — followed by a zero
 * next-IFD offset. A SHORT's value sits left-aligned in its four-byte field, which is why the number
 * is written at the start of that field and the remaining two bytes are zero.
 *
 * @param width pixels across, as stored in the bitmap — before any orientation is applied
 * @param height pixels down, as stored
 * @param orientation the EXIF orientation tag to declare, 1–8
 * @returns the encoded JPEG, with the tag in front of its frame header
 */
export async function jpegOrientedAt(width: number, height: number, orientation: number): Promise<Buffer> {
	const jpeg = Buffer.from(await new Jimp({ width, height, color: 0xff0000ff }).getBuffer(JimpMime.jpeg));

	const app1 = Buffer.alloc(2 + 34);
	app1.writeUInt16BE(0xffe1, 0);
	// The length covers itself and everything after it, but not the marker: 2 + 6 + 8 + 18.
	app1.writeUInt16BE(34, 2);
	app1.write("Exif\0\0", 4, "latin1");

	const tiff = 10;
	app1.write("MM", tiff, "latin1");
	app1.writeUInt16BE(0x002a, tiff + 2);
	app1.writeUInt32BE(8, tiff + 4);
	app1.writeUInt16BE(1, tiff + 8);
	app1.writeUInt16BE(0x0112, tiff + 10);
	app1.writeUInt16BE(3, tiff + 12);
	app1.writeUInt32BE(1, tiff + 14);
	app1.writeUInt16BE(orientation, tiff + 18);
	app1.writeUInt16BE(0, tiff + 20);
	app1.writeUInt32BE(0, tiff + 22);

	return Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]);
}

/**
 * A PNG that claims a size in its header and has no image behind it.
 *
 * Thirty-three bytes: the signature and an IHDR. Nothing can decode it, and that is the entire
 * point — it is the only shape that can tell a header-first guard from a decode-first one. A real
 * PNG of an oversized shape proves nothing, because a check made *after* the decode refuses it just
 * as loudly as one made before, and the whole reason these defences exist is that the allocation
 * being defended against happens inside the decode. So a refusal naming the dimensions is proof the
 * size was read from the header; a refusal saying the file could not be read is proof it was not.
 *
 * `asset-service.test.ts` has its own copy of this, deliberately left there: that suite is the
 * acceptance condition for the guard's extraction and must not be edited as part of moving code
 * around it.
 *
 * @param width the width to claim
 * @param height the height to claim
 * @returns a PNG header with no pixel data
 */
export function pngHeaderClaiming(width: number, height: number): Buffer {
	const png = Buffer.alloc(33);
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
	png.writeUInt32BE(13, 8);
	png.write("IHDR", 12, "ascii");
	png.writeUInt32BE(width, 16);
	png.writeUInt32BE(height, 20);
	png[24] = 8; // bit depth
	png[25] = 6; // RGBA
	png[28] = 0; // interlace: none
	return png;
}
