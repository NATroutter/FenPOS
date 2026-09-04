import { describe, expect, it } from "vitest";
import { readBoundedJson, readBoundedText } from "@/lib/api/bounded-body";
import { ApiError } from "@/lib/errors";

/**
 * Reading a request body without first holding all of it.
 *
 * The size was checked after `request.text()` had already run, so a body the route was going to
 * refuse was received in full and turned into a string before the comparison that rejected it: the
 * refusal cost the server the whole body and the caller one request, which is the wrong way round on
 * the unauthenticated routes this guards. What matters now is not only that the right bodies are
 * refused but that a refused body is never materialised.
 */

/** A request whose body arrives in chunks with no declared length, the way `chunked` framing does. */
function streamed(chunks: string[], headers: Record<string, string> = {}): Request {
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(encoder.encode(chunk));
			}
			controller.close();
		},
	});
	// `duplex` is required by the fetch spec whenever a stream is used as a body.
	return new Request("http://localhost/x", { method: "POST", body, headers, duplex: "half" } as RequestInit & {
		duplex: "half";
	});
}

describe("reading a bounded body", () => {
	it("returns a body inside the cap unchanged", async () => {
		const request = new Request("http://localhost/x", { method: "POST", body: '{"a":1}' });

		expect(await readBoundedText(request, 1_000, "too big")).toBe('{"a":1}');
	});

	it("counts bytes rather than characters", async () => {
		// Three characters, six bytes. A cap compared against `.length` would accept this.
		const request = new Request("http://localhost/x", { method: "POST", body: "åäö" });

		await expect(readBoundedText(request, 5, "too big")).rejects.toThrow(ApiError);
	});

	it("refuses on the declared length, without consuming the body", async () => {
		const request = new Request("http://localhost/x", {
			method: "POST",
			body: "x".repeat(400),
			headers: { "content-length": "999999" },
		});

		await expect(readBoundedText(request, 10, "too big")).rejects.toThrow("too big");

		// The whole point, stated as a property of the request rather than by counting reads: an
		// oversized body is refused on its declared length, so the body is left undisturbed and the
		// refusal costs nothing. `bodyUsed` is what "this function reached for the body" means here —
		// counting `pull` calls measures the fetch implementation filling its own buffer at
		// construction, which happens either way and says nothing about this code.
		expect(request.bodyUsed).toBe(false);
	});

	it("stops reading a chunked body once it passes the cap", async () => {
		// No declared length, so the length check cannot fire and the streaming count is the only bound.
		const request = streamed(["12345", "67890", "abcde"]);

		await expect(readBoundedText(request, 8, "too big")).rejects.toThrow("too big");
	});

	it("accepts a chunked body that stays inside the cap", async () => {
		const request = streamed(["12345", "678"]);

		expect(await readBoundedText(request, 8, "too big")).toBe("12345678");
	});

	it("reads a body whose declared length is malformed, then bounds it while reading", async () => {
		// A header that is not a number is treated as no header rather than as a refusal: the streaming
		// count below is the real bound, and refusing here would turn a bad header into a different
		// error than the body deserves.
		const request = streamed(["12345678901234"], { "content-length": "not-a-number" });

		await expect(readBoundedText(request, 8, "too big")).rejects.toThrow("too big");
	});

	it("reads an absent body as empty rather than failing", async () => {
		expect(await readBoundedText(new Request("http://localhost/x"), 10, "too big")).toBe("");
	});

	it("parses JSON through the same bound", async () => {
		const request = new Request("http://localhost/x", { method: "POST", body: '{"a":1}' });

		expect(await readBoundedJson(request, 1_000)).toEqual({ body: { a: 1 }, raw: '{"a":1}' });
	});

	it("reports a body that is not JSON as such, not as too large", async () => {
		const request = new Request("http://localhost/x", { method: "POST", body: "{" });

		await expect(readBoundedJson(request, 1_000)).rejects.toThrow("Body is not valid JSON");
	});

	it("reports an oversized JSON body as too large, without parsing it", async () => {
		const request = new Request("http://localhost/x", { method: "POST", body: `{"a":"${"x".repeat(200)}"}` });

		await expect(readBoundedJson(request, 50)).rejects.toThrow(/under 50 bytes/);
	});
});
