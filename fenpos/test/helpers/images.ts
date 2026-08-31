import { Jimp, JimpMime } from "jimp";

/**
 * A real PNG of the given size, for tests that need bytes a decoder will accept.
 *
 * Encoded rather than hand-built, because the callers that want this want a file that gets *past*
 * the header checks and into the decoder — a fabricated header would be refused before the decode
 * and would prove nothing about it. Tests that deliberately want a header with no image behind it
 * build one themselves; see `headerClaiming` in `test/lib/assets/asset-service.test.ts`.
 *
 * @param width pixels across
 * @param height pixels down
 * @returns the encoded PNG
 */
export async function pngOf(width: number, height: number): Promise<Buffer> {
	return Buffer.from(await new Jimp({ width, height, color: 0xffffffff }).getBuffer(JimpMime.png));
}
