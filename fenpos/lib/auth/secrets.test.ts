import { describe, expect, it } from "vitest";
import { generatePairingCode, generateToken, hashSecret, normalizePairingCode, secretsMatch } from "@/lib/auth/secrets";

describe("generateToken", () => {
	it("produces URL-safe output", () => {
		for (let attempt = 0; attempt < 50; attempt += 1) {
			expect(generateToken()).toMatch(/^[A-Za-z0-9_-]+$/);
		}
	});

	it("produces 256 bits by default", () => {
		// 32 bytes in base64url is 43 characters, unpadded.
		expect(generateToken()).toHaveLength(43);
	});

	it("does not repeat", () => {
		const tokens = new Set(Array.from({ length: 500 }, () => generateToken()));
		expect(tokens.size).toBe(500);
	});
});

describe("hashSecret", () => {
	it("is deterministic, which is what makes indexed lookup possible", () => {
		expect(hashSecret("abc")).toBe(hashSecret("abc"));
	});

	it("produces a hex SHA-256", () => {
		expect(hashSecret("abc")).toMatch(/^[0-9a-f]{64}$/);
		// Known SHA-256 of "abc", so a change of algorithm cannot pass unnoticed.
		expect(hashSecret("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
	});

	it("separates distinct inputs", () => {
		expect(hashSecret("abc")).not.toBe(hashSecret("abd"));
	});
});

describe("secretsMatch", () => {
	it("accepts identical values", () => {
		expect(secretsMatch("token-value", "token-value")).toBe(true);
	});

	it("rejects differing values of equal length", () => {
		expect(secretsMatch("token-value", "token-valuf")).toBe(false);
	});

	it("rejects differing lengths without throwing", () => {
		expect(secretsMatch("short", "considerably-longer")).toBe(false);
	});

	it("rejects empty against non-empty", () => {
		expect(secretsMatch("", "x")).toBe(false);
	});
});

describe("generatePairingCode", () => {
	it("is formatted in three groups of four", () => {
		expect(generatePairingCode()).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
	});

	it("never emits the characters Crockford excludes", () => {
		// I, L, O and U are the ones mistaken for digits or each other. Emitting them would
		// make the code ambiguous to read aloud, which is how it is usually transferred.
		for (let attempt = 0; attempt < 300; attempt += 1) {
			expect(generatePairingCode()).not.toMatch(/[ILOU]/);
		}
	});

	it("round-trips through normalisation unchanged", () => {
		for (let attempt = 0; attempt < 100; attempt += 1) {
			const code = generatePairingCode();
			expect(normalizePairingCode(code)).toBe(code);
		}
	});

	it("does not repeat across many draws", () => {
		const codes = new Set(Array.from({ length: 1000 }, () => generatePairingCode()));
		expect(codes.size).toBe(1000);
	});

	it("uses most of the alphabet, so sampling is not stuck on a subset", () => {
		const seen = new Set<string>();
		for (let attempt = 0; attempt < 400; attempt += 1) {
			for (const character of generatePairingCode().replace(/-/g, "")) {
				seen.add(character);
			}
		}
		expect(seen.size).toBe(32);
	});
});

describe("normalizePairingCode", () => {
	it("accepts the canonical form", () => {
		expect(normalizePairingCode("AG7K-2M9P-X4TR")).toBe("AG7K-2M9P-X4TR");
	});

	it("accepts lower case", () => {
		expect(normalizePairingCode("ag7k-2m9p-x4tr")).toBe("AG7K-2M9P-X4TR");
	});

	it("accepts missing or unusual grouping", () => {
		expect(normalizePairingCode("AG7K2M9PX4TR")).toBe("AG7K-2M9P-X4TR");
		expect(normalizePairingCode("AG 7K 2M 9P X4 TR")).toBe("AG7K-2M9P-X4TR");
	});

	it("maps the letters an operator mistakes for digits", () => {
		// O for 0 and I or L for 1 are the transcription errors this format expects.
		expect(normalizePairingCode("OG7K-2M9P-X4TR")).toBe("0G7K-2M9P-X4TR");
		expect(normalizePairingCode("IG7K-2M9P-X4TR")).toBe("1G7K-2M9P-X4TR");
		expect(normalizePairingCode("LG7K-2M9P-X4TR")).toBe("1G7K-2M9P-X4TR");
		expect(normalizePairingCode("UG7K-2M9P-X4TR")).toBe("VG7K-2M9P-X4TR");
	});

	it("rejects wrong lengths", () => {
		expect(normalizePairingCode("AG7K-2M9P")).toBeNull();
		expect(normalizePairingCode("AG7K-2M9P-X4TRX")).toBeNull();
		expect(normalizePairingCode("")).toBeNull();
	});

	it("rejects characters outside the alphabet", () => {
		expect(normalizePairingCode("AG7K-2M9P-X4T!")).toBeNull();
		expect(normalizePairingCode("AG7K-2M9P-X4Tä")).toBeNull();
	});
});
