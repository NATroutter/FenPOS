/**
 * What an uploaded file turned out to be.
 *
 * `null` for anything this system does not store, which is everything that is not a PNG, a JPEG, a
 * TrueType font or a CFF one.
 */
export type DetectedKind = { kind: "IMAGE" } | { kind: "FONT"; mimeType: "font/ttf" | "font/otf" } | null;

/** The first bytes of a PNG: the signature's fixed prefix, which no other format shares. */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

/** SOI, the two bytes every JPEG opens with. */
const JPEG_MAGIC = [0xff, 0xd8];

/**
 * The four bytes an sfnt font opens with, one per flavour.
 *
 * `00 01 00 00` is TrueType's version number and `true` is the tag Apple's own TrueType files carry;
 * both hold glyf outlines and both are served as `font/ttf`. `OTTO` marks CFF outlines, which is
 * what `font/otf` means. `ttcf` — a collection of several faces in one file — is deliberately
 * absent: `parseFace` reads one face, and a caller asking for a font by name has no way to say which
 * of the collection they meant.
 */
const FONT_MAGIC: ReadonlyArray<{ magic: readonly number[]; mimeType: "font/ttf" | "font/otf" }> = [
	{ magic: [0x00, 0x01, 0x00, 0x00], mimeType: "font/ttf" },
	{ magic: [0x74, 0x72, 0x75, 0x65], mimeType: "font/ttf" },
	{ magic: [0x4f, 0x54, 0x54, 0x4f], mimeType: "font/otf" },
];

/**
 * Reads what a file is from the file itself.
 *
 * **From the bytes, never from what the caller said.** A filename and a content type are both the
 * uploader's to choose, and getting this wrong in either direction is expensive: a font stored as an
 * image would be dithered for every paper width on every agent connect, and an image stored as a
 * font would be handed to `parseFace` at compile time on every receipt naming it.
 *
 * Only the leading bytes are read. That is enough to tell the four formats apart and it is all that
 * should be trusted here — whether the rest of the file is really a decodable image or a parseable
 * font is settled afterwards by the decoder and by `parseFace`, which are the authorities on that.
 *
 * @param bytes the file exactly as uploaded
 * @returns which kind it is, and for a font which flavour, or null if it is neither
 */
export function detectAssetKind(bytes: Buffer): DetectedKind {
	if (startsWith(bytes, PNG_MAGIC) || startsWith(bytes, JPEG_MAGIC)) {
		return { kind: "IMAGE" };
	}

	for (const { magic, mimeType } of FONT_MAGIC) {
		if (startsWith(bytes, magic)) {
			return { kind: "FONT", mimeType };
		}
	}

	return null;
}

/**
 * Whether a buffer opens with exactly these bytes.
 *
 * @param bytes the file
 * @param magic the byte sequence to match
 * @returns true when the file is at least that long and begins with it
 */
function startsWith(bytes: Buffer, magic: readonly number[]): boolean {
	if (bytes.length < magic.length) {
		return false;
	}
	return magic.every((byte, index) => bytes[index] === byte);
}
