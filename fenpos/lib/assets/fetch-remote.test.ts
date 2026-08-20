import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	fetchRemoteImage,
	MAX_REMOTE_IMAGE_BYTES,
	type PinnedAddress,
	pinnedTransport,
	type RemoteResponse,
	type RemoteTransport,
} from "@/lib/assets/fetch-remote";
import { ApiError } from "@/lib/errors";

/**
 * These tests never touch DNS and never open a socket to anything but loopback.
 *
 * That is deliberate and it is load-bearing. A guard whose suite needs the machine's resolver
 * fails on a plane, in a CI runner without egress, and on any network whose DNS answers
 * `localhost` differently — and a security control whose tests are skipped or flaky is a
 * security control nobody trusts. Every case below either uses a literal IP (which the guard
 * classifies without asking a resolver) or injects a fake resolver and a fake transport.
 *
 * The one exception is {@link pinnedTransport}, which has to be exercised against a real socket
 * to be worth anything. It gets a `node:http` server bound to 127.0.0.1 — no DNS, no egress.
 */

/** A resolved address that is fine to connect to. Reserved for documentation, so it can never move. */
const PUBLIC_V4: PinnedAddress = { address: "93.184.216.34", family: 4 };
const PUBLIC_V6: PinnedAddress = { address: "2606:4700:4700::1111", family: 6 };

const PNG_BYTES = Buffer.from("fake png bytes");

/** A resolver that answers from a table and refuses to know anything else. */
function resolverFor(answers: Record<string, PinnedAddress[]>) {
	return async (hostname: string): Promise<PinnedAddress[]> => answers[hostname] ?? [];
}

/** A resolver that claims every hostname is the same public address. */
const alwaysPublic = async (): Promise<PinnedAddress[]> => [PUBLIC_V4];

/** Yields a buffer as a single-chunk body. */
function oneChunk(bytes: Buffer): AsyncIterable<Uint8Array> {
	return (async function* () {
		yield bytes;
	})();
}

interface StubResponse {
	status?: number;
	location?: string;
	contentLength?: number | null;
	body?: AsyncIterable<Uint8Array>;
}

interface Stub {
	transport: RemoteTransport;
	/** Every URL the transport was asked to open, in order. Redirect hops show up here. */
	readonly asked: string[];
	/** The addresses the transport was offered for each hop, in order. */
	readonly offered: PinnedAddress[][];
	/** How many times a response was cancelled rather than read to the end. */
	cancelled: number;
}

/**
 * A transport that answers from a script instead of a socket.
 *
 * `reply` is called per hop, so a test can redirect the first hop and serve bytes on the second.
 */
function stubTransport(reply: (url: URL, hop: number) => StubResponse): Stub {
	const stub: Stub = { asked: [], offered: [], cancelled: 0, transport: null as unknown as RemoteTransport };
	stub.transport = async (url, offered) => {
		const hop = stub.asked.length;
		stub.asked.push(url.href);
		stub.offered.push(offered);
		const scripted = reply(url, hop);
		const response: RemoteResponse = {
			status: scripted.status ?? 200,
			location: scripted.location ?? null,
			contentLength: scripted.contentLength === undefined ? null : scripted.contentLength,
			body: scripted.body ?? oneChunk(PNG_BYTES),
			cancel: () => {
				stub.cancelled += 1;
			},
		};
		return response;
	};
	return stub;
}

/** A transport that must never be reached, because the guard should have refused first. */
const neverCalled: RemoteTransport = async () => {
	throw new Error("the transport was called, but the guard should have refused this URL");
};

describe("fetchRemoteImage", () => {
	// --- The brief's cases ---

	it("refuses a scheme that is not http or https", async () => {
		await expect(fetchRemoteImage("file:///etc/passwd")).rejects.toThrow(/http/i);
	});

	it("refuses loopback", async () => {
		await expect(fetchRemoteImage("http://127.0.0.1/logo.png")).rejects.toThrow(/address/i);
	});

	it("refuses a private range", async () => {
		await expect(fetchRemoteImage("http://192.168.1.1/logo.png")).rejects.toThrow(/address/i);
	});

	it("refuses link-local", async () => {
		await expect(fetchRemoteImage("http://169.254.169.254/latest/meta-data")).rejects.toThrow(/address/i);
	});

	/**
	 * The brief runs this against the real `localhost`. It is injected here instead so the suite
	 * does not depend on the machine's hosts file, but the assertion is the same one: the check
	 * runs on what the name resolved to, not on the name.
	 */
	it("refuses a hostname that resolves inward", async () => {
		const resolve = resolverFor({ localhost: [{ address: "127.0.0.1", family: 4 }] });
		await expect(fetchRemoteImage("http://localhost/logo.png", { resolve, transport: neverCalled })).rejects.toThrow(
			/address/i,
		);
	});

	// --- Acceptance. A guard that refuses everything passes every refusal test. ---

	it("returns the bytes of a legitimate public image", async () => {
		const stub = stubTransport(() => ({}));
		const bytes = await fetchRemoteImage("https://cdn.example.com/logo.png", {
			resolve: alwaysPublic,
			transport: stub.transport,
		});
		expect(bytes.equals(PNG_BYTES)).toBe(true);
		expect(stub.asked).toEqual(["https://cdn.example.com/logo.png"]);
	});

	it("accepts plain http as well as https", async () => {
		const stub = stubTransport(() => ({}));
		const bytes = await fetchRemoteImage("http://cdn.example.com/logo.png", {
			resolve: alwaysPublic,
			transport: stub.transport,
		});
		expect(bytes.equals(PNG_BYTES)).toBe(true);
	});

	it("accepts a public IPv6 host", async () => {
		const stub = stubTransport(() => ({}));
		await expect(
			fetchRemoteImage("http://[2606:4700:4700::1111]/logo.png", { transport: stub.transport }),
		).resolves.toBeInstanceOf(Buffer);
		expect(stub.offered).toEqual([[PUBLIC_V6]]);
	});

	it("accepts a non-standard port on a public host", async () => {
		const stub = stubTransport(() => ({}));
		await expect(
			fetchRemoteImage("http://cdn.example.com:8443/logo.png", { resolve: alwaysPublic, transport: stub.transport }),
		).resolves.toBeInstanceOf(Buffer);
	});

	// --- Schemes ---

	it.each([
		"ftp://example.com/logo.png",
		"gopher://example.com/1",
		"data:image/png;base64,AAAA",
	])("refuses the scheme in %s", async (url) => {
		await expect(fetchRemoteImage(url, { resolve: alwaysPublic, transport: neverCalled })).rejects.toThrow(/http/i);
	});

	it("refuses something that is not a URL at all", async () => {
		await expect(fetchRemoteImage("logo.png", { transport: neverCalled })).rejects.toThrow(/http/i);
	});

	// --- Every address class the guard blocks ---

	it.each([
		["0.0.0.0", /unspecified/i],
		["10.1.2.3", /private/i],
		["100.64.0.1", /carrier/i],
		["127.0.0.1", /loopback/i],
		// Not just 127.0.0.1. The whole /8 answers on a Linux host.
		["127.9.9.9", /loopback/i],
		["169.254.169.254", /link-local/i],
		["172.16.0.1", /private/i],
		["172.31.255.255", /private/i],
		["192.0.0.1", /protocol assignment/i],
		["192.168.1.1", /private/i],
		["198.18.0.5", /benchmark/i],
		["224.0.0.1", /multicast/i],
		["240.0.0.1", /reserved/i],
		["255.255.255.255", /reserved/i],
		["[::1]", /loopback/i],
		["[::]", /unspecified/i],
		["[fe80::1]", /link-local/i],
		["[fc00::1]", /unique-local/i],
		["[fd00::1]", /unique-local/i],
		["[ff02::1]", /multicast/i],
		// IPv4-mapped IPv6. A check that only looks for `::1` and `fc00::/7` waves these through.
		["[::ffff:127.0.0.1]", /loopback/i],
		["[::ffff:192.168.1.1]", /private/i],
		["[::ffff:169.254.169.254]", /link-local/i],
		["[::ffff:8.8.8.8]", /IPv4-mapped/i],
		["[64:ff9b::7f00:1]", /NAT64/i],
		["[2001::1]", /Teredo/i],
		["[2002:c0a8:0101::1]", /6to4/i],
		["[2001:db8::1]", /documentation/i],
		// Outside 2000::/3 entirely: the guard allows global unicast and nothing else.
		["[fec0::1]", /global unicast/i],
		["[100::1]", /global unicast/i],
	])("refuses %s", async (host, why) => {
		await expect(fetchRemoteImage(`http://${host}/logo.png`, { transport: neverCalled })).rejects.toThrow(why);
	});

	/**
	 * `http://0177.0.0.1/` and `http://2130706433/` are both loopback written to look like something
	 * else. WHATWG URL parsing normalises them to `127.0.0.1` before the guard ever sees them, which
	 * is exactly why the guard reads `URL.hostname` rather than slicing the string itself.
	 */
	it.each(["0177.0.0.1", "2130706433", "127.1"])("refuses loopback written as %s", async (host) => {
		await expect(fetchRemoteImage(`http://${host}/logo.png`, { transport: neverCalled })).rejects.toThrow(/loopback/i);
	});

	it("refuses when any one of several resolved addresses is private", async () => {
		const resolve = resolverFor({
			"cdn.example.com": [PUBLIC_V4, { address: "10.0.0.7", family: 4 }],
		});
		await expect(
			fetchRemoteImage("http://cdn.example.com/logo.png", { resolve, transport: neverCalled }),
		).rejects.toThrow(/private/i);
	});

	it("refuses a hostname that resolves to nothing", async () => {
		await expect(
			fetchRemoteImage("http://nowhere.example.com/logo.png", { resolve: resolverFor({}), transport: neverCalled }),
		).rejects.toThrow(/address/i);
	});

	it("refuses a resolver answer that is not an IP address", async () => {
		const resolve = resolverFor({ "cdn.example.com": [{ address: "not-an-ip", family: 4 }] });
		await expect(
			fetchRemoteImage("http://cdn.example.com/logo.png", { resolve, transport: neverCalled }),
		).rejects.toThrow(/address/i);
	});

	it("connects to the address it validated, not to the hostname", async () => {
		const stub = stubTransport(() => ({}));
		await fetchRemoteImage("http://cdn.example.com/logo.png", { resolve: alwaysPublic, transport: stub.transport });
		expect(stub.offered).toEqual([[PUBLIC_V4]]);
	});

	/**
	 * Every one of these was validated, so every one of them may be connected to — and the transport
	 * needs all of them, not just the first.
	 *
	 * `dns.lookup` is asked with `verbatim: true`, which means no IPv4-first reordering: a dual-stack
	 * CDN commonly answers with its AAAA record first. Offering only the first address would pin an
	 * IPv6 address on a shop LAN that has no IPv6 route and fail a perfectly legitimate public image
	 * that ordinary `fetch` would have retrieved, because Node would never get to try the A record.
	 * Handing over the whole validated set lets Node fall through them (Happy Eyeballs) while every
	 * address it can possibly reach is still one the guard approved.
	 */
	it("offers every validated address to the transport, not just the first", async () => {
		const answers = [PUBLIC_V6, PUBLIC_V4];
		const stub = stubTransport(() => ({}));
		await fetchRemoteImage("http://cdn.example.com/logo.png", {
			resolve: resolverFor({ "cdn.example.com": answers }),
			transport: stub.transport,
		});
		expect(stub.offered).toEqual([answers]);
	});

	it("offers the full validated set on every redirect hop", async () => {
		const answers = [PUBLIC_V6, PUBLIC_V4];
		const stub = stubTransport((_url, hop) =>
			hop === 0 ? { status: 302, location: "https://images.example.net/logo.png" } : {},
		);
		await fetchRemoteImage("http://cdn.example.com/logo.png", {
			resolve: resolverFor({ "cdn.example.com": answers, "images.example.net": answers }),
			transport: stub.transport,
		});
		expect(stub.offered).toEqual([answers, answers]);
	});
});

/**
 * A URL may carry credentials, and they must not come back out.
 *
 * `ApiError.toBody()` spreads `details` into the response body, and the panel writes those same
 * details into the log it displays. A receipt author who writes
 * `<image>https://alice:hunter2@cdn.example.com/logo.png</image>` would otherwise have the password
 * echoed to whoever submitted the job and left sitting in the log afterwards. They are leaking their
 * own credential rather than someone else's, which is why this is not an emergency — but a security
 * control should not be the thing that copies a password into two new places.
 */
describe("fetchRemoteImage credentials", () => {
	const SECRET = "hunter2";

	async function refusalFrom(url: string, options: Parameters<typeof fetchRemoteImage>[1] = {}): Promise<ApiError> {
		const thrown = await fetchRemoteImage(url, { transport: neverCalled, ...options }).catch((error: unknown) => error);
		expect(thrown).toBeInstanceOf(ApiError);
		return thrown as ApiError;
	}

	it("keeps the password out of the details of an address refusal", async () => {
		const failure = await refusalFrom(`http://alice:${SECRET}@127.0.0.1/logo.png`);
		expect(JSON.stringify(failure.toBody())).not.toContain(SECRET);
	});

	it("keeps the password out of the details of a refusal on a resolved hostname", async () => {
		const failure = await refusalFrom(`http://alice:${SECRET}@cdn.example.com/logo.png`, {
			resolve: resolverFor({ "cdn.example.com": [{ address: "10.0.0.7", family: 4 }] }),
		});
		expect(JSON.stringify(failure.toBody())).not.toContain(SECRET);
	});

	it("keeps the password out of a refusal for a URL that would not even parse", async () => {
		const failure = await refusalFrom(`//alice:${SECRET}@cdn.example.com/logo.png`);
		expect(JSON.stringify(failure.toBody())).not.toContain(SECRET);
	});

	it("keeps the password out of a redirect-limit refusal", async () => {
		const stub = stubTransport((url) => ({ status: 302, location: url.href }));
		const failure = await refusalFrom(`http://alice:${SECRET}@cdn.example.com/logo.png`, {
			resolve: alwaysPublic,
			transport: stub.transport,
		});
		expect(JSON.stringify(failure.toBody())).not.toContain(SECRET);
	});

	it("keeps the password out of a refusal from an upstream status", async () => {
		const stub = stubTransport(() => ({ status: 404 }));
		const failure = await refusalFrom(`http://alice:${SECRET}@cdn.example.com/logo.png`, {
			resolve: alwaysPublic,
			transport: stub.transport,
		});
		expect(JSON.stringify(failure.toBody())).not.toContain(SECRET);
	});

	it("keeps the password out of an oversize refusal", async () => {
		const stub = stubTransport(() => ({ contentLength: MAX_REMOTE_IMAGE_BYTES + 1 }));
		const failure = await refusalFrom(`http://alice:${SECRET}@cdn.example.com/logo.png`, {
			resolve: alwaysPublic,
			transport: stub.transport,
		});
		expect(JSON.stringify(failure.toBody())).not.toContain(SECRET);
	});

	/** Redacting must not reduce the detail to uselessness: the host and path still have to be there. */
	it("still names the host and path it refused", async () => {
		const failure = await refusalFrom(`http://alice:${SECRET}@127.0.0.1/logo.png`);
		expect(failure.details.url).toBe("http://127.0.0.1/logo.png");
	});

	/** The credentials are stripped from what is reported, never from what is requested. */
	it("still sends the credentials to the server itself", async () => {
		const stub = stubTransport(() => ({}));
		await fetchRemoteImage(`http://alice:${SECRET}@cdn.example.com/logo.png`, {
			resolve: alwaysPublic,
			transport: stub.transport,
		});
		expect(stub.asked).toEqual([`http://alice:${SECRET}@cdn.example.com/logo.png`]);
	});
});

describe("fetchRemoteImage redirects", () => {
	/**
	 * The single most valuable test in this file.
	 *
	 * `cdn.example.com` is public and passes the guard. It then answers 302 to the cloud metadata
	 * endpoint. A guard that validates only the URL it was handed is bypassed completely here, and
	 * `fetch`'s default of following redirects silently makes that the easy mistake to make.
	 */
	it("refuses a redirect to a private address", async () => {
		const resolve = resolverFor({ "cdn.example.com": [PUBLIC_V4] });
		const stub = stubTransport(() => ({ status: 302, location: "http://169.254.169.254/latest/meta-data/" }));
		await expect(
			fetchRemoteImage("http://cdn.example.com/logo.png", { resolve, transport: stub.transport }),
		).rejects.toThrow(/link-local/i);
		// The second hop must never have been opened.
		expect(stub.asked).toEqual(["http://cdn.example.com/logo.png"]);
	});

	it.each([301, 302, 303, 307, 308])("refuses a %d to a private address", async (status) => {
		const stub = stubTransport(() => ({ status, location: "http://192.168.1.1/logo.png" }));
		await expect(
			fetchRemoteImage("http://cdn.example.com/logo.png", { resolve: alwaysPublic, transport: stub.transport }),
		).rejects.toThrow(/private/i);
	});

	it("follows a redirect to another public host", async () => {
		const stub = stubTransport((_url, hop) =>
			hop === 0 ? { status: 301, location: "https://images.example.net/logo.png" } : {},
		);
		const bytes = await fetchRemoteImage("http://cdn.example.com/logo.png", {
			resolve: alwaysPublic,
			transport: stub.transport,
		});
		expect(bytes.equals(PNG_BYTES)).toBe(true);
		expect(stub.asked).toEqual(["http://cdn.example.com/logo.png", "https://images.example.net/logo.png"]);
	});

	it("resolves a relative Location against the hop it came from", async () => {
		const stub = stubTransport((_url, hop) => (hop === 0 ? { status: 302, location: "/real/logo.png" } : {}));
		await fetchRemoteImage("http://cdn.example.com/a/b/logo.png", {
			resolve: alwaysPublic,
			transport: stub.transport,
		});
		expect(stub.asked[1]).toBe("http://cdn.example.com/real/logo.png");
	});

	it("refuses a redirect that changes to a scheme other than http or https", async () => {
		const stub = stubTransport(() => ({ status: 302, location: "file:///etc/passwd" }));
		await expect(
			fetchRemoteImage("http://cdn.example.com/logo.png", { resolve: alwaysPublic, transport: stub.transport }),
		).rejects.toThrow(/http/i);
	});

	it("refuses a redirect with no Location header", async () => {
		const stub = stubTransport(() => ({ status: 302 }));
		await expect(
			fetchRemoteImage("http://cdn.example.com/logo.png", { resolve: alwaysPublic, transport: stub.transport }),
		).rejects.toThrow(/redirect/i);
	});

	it("refuses a redirect loop rather than following it forever", async () => {
		const stub = stubTransport((url) => ({ status: 302, location: url.href }));
		await expect(
			fetchRemoteImage("http://cdn.example.com/logo.png", { resolve: alwaysPublic, transport: stub.transport }),
		).rejects.toThrow(/redirect/i);
		expect(stub.asked.length).toBeLessThanOrEqual(8);
	});

	it("abandons each redirect response instead of leaving it open", async () => {
		const stub = stubTransport((_url, hop) =>
			hop === 0 ? { status: 302, location: "https://images.example.net/logo.png" } : {},
		);
		await fetchRemoteImage("http://cdn.example.com/logo.png", { resolve: alwaysPublic, transport: stub.transport });
		expect(stub.cancelled).toBe(2);
	});

	it("refuses a response that is neither success nor redirect", async () => {
		const stub = stubTransport(() => ({ status: 404 }));
		await expect(
			fetchRemoteImage("http://cdn.example.com/logo.png", { resolve: alwaysPublic, transport: stub.transport }),
		).rejects.toThrow(/404/);
	});
});

describe("fetchRemoteImage size cap", () => {
	const CHUNK = 256 * 1024;
	/** Eight times the cap. Far past any legitimate image, and bounded only so that an
	 * implementation which buffers first and measures afterwards fails an assertion here instead
	 * of running until the suite times out. A real hostile server would not stop. */
	const OVERSIZED_CHUNKS = (8 * MAX_REMOTE_IMAGE_BYTES) / CHUNK;

	/** A body far larger than the cap, which counts how much of it the reader actually pulled. */
	function oversizedBody(): { body: AsyncIterable<Uint8Array>; pulled: () => number; closed: () => boolean } {
		let pulled = 0;
		let closed = false;
		const body = (async function* () {
			try {
				for (let sent = 0; sent < OVERSIZED_CHUNKS; sent++) {
					pulled += CHUNK;
					yield Buffer.alloc(CHUNK);
				}
			} finally {
				closed = true;
			}
		})();
		return { body, pulled: () => pulled, closed: () => closed };
	}

	/**
	 * The point of the cap is that the process never holds the oversized body, so this asserts on
	 * how much was pulled — not merely that the call rejected. Downloading it all and then checking
	 * `.length` would pass a rejection test and still let a hostile server exhaust memory.
	 */
	it("aborts an oversized body instead of buffering it", async () => {
		const oversized = oversizedBody();
		const stub = stubTransport(() => ({ body: oversized.body }));
		await expect(
			fetchRemoteImage("http://cdn.example.com/logo.png", { resolve: alwaysPublic, transport: stub.transport }),
		).rejects.toThrow(/large/i);
		expect(oversized.pulled()).toBeLessThanOrEqual(MAX_REMOTE_IMAGE_BYTES + CHUNK);
		expect(oversized.closed()).toBe(true);
		expect(stub.cancelled).toBe(1);
	});

	/**
	 * `Content-Length` comes from the server being guarded against, so it can only ever be an
	 * early-out. A server that declares 1 KB and sends 100 MB must still be cut off.
	 */
	it("caps a body whose Content-Length lied about being small", async () => {
		const oversized = oversizedBody();
		const stub = stubTransport(() => ({ contentLength: 1024, body: oversized.body }));
		await expect(
			fetchRemoteImage("http://cdn.example.com/logo.png", { resolve: alwaysPublic, transport: stub.transport }),
		).rejects.toThrow(/large/i);
		expect(oversized.pulled()).toBeLessThanOrEqual(MAX_REMOTE_IMAGE_BYTES + CHUNK);
	});

	it("refuses on an oversized Content-Length without reading the body at all", async () => {
		const oversized = oversizedBody();
		const stub = stubTransport(() => ({ contentLength: MAX_REMOTE_IMAGE_BYTES + 1, body: oversized.body }));
		await expect(
			fetchRemoteImage("http://cdn.example.com/logo.png", { resolve: alwaysPublic, transport: stub.transport }),
		).rejects.toThrow(/large/i);
		expect(oversized.pulled()).toBe(0);
	});

	it("accepts a body exactly at the cap", async () => {
		const stub = stubTransport(() => ({ body: oneChunk(Buffer.alloc(MAX_REMOTE_IMAGE_BYTES)) }));
		const bytes = await fetchRemoteImage("http://cdn.example.com/logo.png", {
			resolve: alwaysPublic,
			transport: stub.transport,
		});
		expect(bytes.length).toBe(MAX_REMOTE_IMAGE_BYTES);
	});

	it("refuses one byte over the cap", async () => {
		const stub = stubTransport(() => ({ body: oneChunk(Buffer.alloc(MAX_REMOTE_IMAGE_BYTES + 1)) }));
		await expect(
			fetchRemoteImage("http://cdn.example.com/logo.png", { resolve: alwaysPublic, transport: stub.transport }),
		).rejects.toThrow(/large/i);
	});

	it("joins a body that arrives in several chunks", async () => {
		const stub = stubTransport(() => ({
			body: (async function* () {
				yield Buffer.from("fake ");
				yield Buffer.from("png ");
				yield Buffer.from("bytes");
			})(),
		}));
		const bytes = await fetchRemoteImage("http://cdn.example.com/logo.png", {
			resolve: alwaysPublic,
			transport: stub.transport,
		});
		expect(bytes.toString()).toBe("fake png bytes");
	});
});

describe("fetchRemoteImage timeout", () => {
	it("gives up on a transport that never answers", async () => {
		const transport: RemoteTransport = () => new Promise<RemoteResponse>(() => {});
		await expect(
			fetchRemoteImage("http://cdn.example.com/logo.png", {
				resolve: alwaysPublic,
				transport,
				timeoutMs: 20,
			}),
		).rejects.toThrow(/time/i);
	});

	it("gives up on a body that stalls part-way through", async () => {
		const stub = stubTransport(() => ({
			body: (async function* () {
				yield Buffer.from("start");
				await new Promise(() => {});
			})(),
		}));
		await expect(
			fetchRemoteImage("http://cdn.example.com/logo.png", {
				resolve: alwaysPublic,
				transport: stub.transport,
				timeoutMs: 20,
			}),
		).rejects.toThrow(/time/i);
	});

	/** One budget for the whole fetch, not one per hop, or five redirects would buy five times the wait. */
	it("spends one budget across every redirect hop", async () => {
		const stub = stubTransport((url) => ({ status: 302, location: url.href }));
		const started = Date.now();
		await expect(
			fetchRemoteImage("http://cdn.example.com/logo.png", {
				resolve: async () => {
					await new Promise((done) => setTimeout(done, 30));
					return [PUBLIC_V4];
				},
				transport: stub.transport,
				timeoutMs: 40,
			}),
		).rejects.toThrow(/time/i);
		expect(Date.now() - started).toBeLessThan(200);
	});

	it("reports a transport failure without leaking the underlying error", async () => {
		const transport: RemoteTransport = async () => {
			throw new Error("connect ECONNREFUSED 93.184.216.34:80");
		};
		const failure = await fetchRemoteImage("http://cdn.example.com/logo.png", {
			resolve: alwaysPublic,
			transport,
		}).catch((thrown: Error) => thrown);
		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).not.toMatch(/ECONNREFUSED/);
		expect((failure as Error).cause).toBeInstanceOf(Error);
	});
});

/**
 * The real transport, against a real socket.
 *
 * Everything above injects a fake transport, so without this nothing would prove that the pinning
 * works — that `node:http` actually calls the supplied `lookup` and connects where it is told
 * rather than where DNS points. The server is bound to 127.0.0.1, so this stays hermetic.
 */
describe("pinnedTransport", () => {
	let server: Server;
	let port = 0;

	beforeAll(async () => {
		server = createServer((request, response) => {
			if (request.url === "/redirect") {
				response.writeHead(302, { location: "/logo.png" });
				response.end();
				return;
			}
			if (request.url === "/oversized") {
				response.writeHead(200, { "content-type": "image/png" });
				const pump = () => {
					if (response.writableEnded) {
						return;
					}
					if (response.write(Buffer.alloc(64 * 1024))) {
						setImmediate(pump);
					} else {
						response.once("drain", pump);
					}
				};
				pump();
				return;
			}
			response.writeHead(200, { "content-type": "image/png", "content-length": String(PNG_BYTES.length) });
			response.end(PNG_BYTES);
		});
		await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
		port = (server.address() as AddressInfo).port;
	});

	afterAll(async () => {
		await new Promise<void>((done) => server.close(() => done()));
	});

	async function drain(body: AsyncIterable<Uint8Array>): Promise<Buffer> {
		const chunks: Uint8Array[] = [];
		for await (const chunk of body) {
			chunks.push(chunk);
		}
		return Buffer.concat(chunks);
	}

	/**
	 * The hostname is deliberately unresolvable. If `lookup` were being ignored this would fail with
	 * ENOTFOUND rather than returning the fixture, which is precisely the assertion.
	 */
	it("connects to the pinned address rather than resolving the hostname", async () => {
		const url = new URL(`http://not-a-real-host.invalid:${port}/logo.png`);
		const response = await pinnedTransport(url, [{ address: "127.0.0.1", family: 4 }], AbortSignal.timeout(5000));
		expect(response.status).toBe(200);
		expect(response.contentLength).toBe(PNG_BYTES.length);
		expect((await drain(response.body)).equals(PNG_BYTES)).toBe(true);
	});

	it("surfaces a redirect rather than following it itself", async () => {
		const url = new URL(`http://not-a-real-host.invalid:${port}/redirect`);
		const response = await pinnedTransport(url, [{ address: "127.0.0.1", family: 4 }], AbortSignal.timeout(5000));
		expect(response.status).toBe(302);
		expect(response.location).toBe("/logo.png");
		response.cancel();
	});

	it("stops an oversized body when the response is cancelled", async () => {
		const url = new URL(`http://not-a-real-host.invalid:${port}/oversized`);
		const response = await pinnedTransport(url, [{ address: "127.0.0.1", family: 4 }], AbortSignal.timeout(5000));
		let read = 0;
		await expect(
			(async () => {
				for await (const chunk of response.body) {
					read += chunk.byteLength;
					if (read > 512 * 1024) {
						response.cancel();
					}
				}
			})(),
		).rejects.toThrow();
		expect(read).toBeLessThan(4 * 1024 * 1024);
	});

	it("rejects when the signal is already aborted", async () => {
		const url = new URL(`http://not-a-real-host.invalid:${port}/logo.png`);
		await expect(pinnedTransport(url, [{ address: "127.0.0.1", family: 4 }], AbortSignal.abort())).rejects.toThrow();
	});
});
