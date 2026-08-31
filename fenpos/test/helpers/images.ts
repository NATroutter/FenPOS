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
