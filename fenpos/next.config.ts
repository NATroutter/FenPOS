import type { NextConfig } from "next";

/**
 * Where Turnstile's widget is served from, and where its iframe runs.
 *
 * Named unconditionally rather than only when `auth.turnstileEnabled` is on: these headers are
 * static configuration and the setting is a database row, so there is no request here to read it
 * from. One fixed Cloudflare host is a small thing to allow and a confusing thing to have to
 * diagnose — a sign-in page whose challenge silently fails to load is the failure this avoids.
 */
const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

/**
 * The Content-Security-Policy every response carries.
 *
 * **Defence in depth, not a patch over a hole.** No injection sink was found in the panel: nothing
 * renders operator text as HTML except the server-drawn TOTP QR, whose SVG comes from bwip-js with
 * no user text in it, and the chart style block, which is config-controlled. This exists so that the
 * *next* sink is not immediately exploitable.
 *
 * `script-src` keeps `'unsafe-inline'` because the App Router bootstraps and streams its payload
 * through inline `<script>` tags; removing it needs a per-request nonce, which needs middleware on
 * every request, and that is a change with its own risks rather than a config line. What the
 * directive still buys with it in place is the thing that matters most: an injected `<script src>`
 * pointing anywhere but this origin does not load, and neither does an exfiltrating `fetch` — see
 * `connect-src`. `'unsafe-eval'` is added only under `next dev`, where the hot-reload client needs
 * it; a production build must not have it.
 *
 * `img-src` allows `data:` and `blob:` because avatars are cropped in the browser before upload and
 * previewed from a blob URL, and dithered asset previews are data URLs.
 *
 * @param dev whether this is the development server
 * @returns the policy, as one header value
 */
function contentSecurityPolicy(dev: boolean): string {
	const scriptSrc = ["'self'", "'unsafe-inline'", TURNSTILE_ORIGIN, ...(dev ? ["'unsafe-eval'"] : [])];

	return [
		"default-src 'self'",
		`script-src ${scriptSrc.join(" ")}`,
		// Tailwind ships as a stylesheet, but Next inlines critical CSS and several components set
		// custom properties through a style attribute, both of which this covers.
		"style-src 'self' 'unsafe-inline'",
		"img-src 'self' data: blob:",
		"font-src 'self' data:",
		// The panel talks only to its own origin: the API, the event stream, the server actions. In
		// development the hot-reload socket is on this origin too.
		"connect-src 'self'",
		`frame-src ${TURNSTILE_ORIGIN}`,
		// Nothing here is meant to be embedded. Paired with X-Frame-Options below for the browsers
		// that honour only the older header.
		"frame-ancestors 'none'",
		"base-uri 'self'",
		"form-action 'self'",
		"object-src 'none'",
	].join("; ");
}

const nextConfig: NextConfig = {
	/**
	 * Response headers applied to everything this server serves.
	 *
	 * On every path rather than only the panel's: the API and the pairing endpoint are served from
	 * the same origin, and a header that applies to most of an origin is a header whose absence is
	 * the interesting case.
	 *
	 * `Strict-Transport-Security` is sent regardless of scheme because a browser ignores it on a
	 * plain-HTTP response — an install reached over HTTP is unaffected, and one behind TLS gets the
	 * protection without an operator having to know to turn it on. `preload` is deliberately absent:
	 * that is a submission to a list baked into browsers, and it is not this file's decision to make
	 * for somebody's LAN appliance.
	 */
	async headers() {
		const dev = process.env.NODE_ENV !== "production";

		return [
			{
				source: "/:path*",
				headers: [
					{ key: "Content-Security-Policy", value: contentSecurityPolicy(dev) },
					{ key: "X-Content-Type-Options", value: "nosniff" },
					{ key: "X-Frame-Options", value: "DENY" },
					// Same-origin: an internal URL can name an agent, a device or a job id, and none of
					// that belongs in a Referer sent to Cloudflare's challenge endpoint.
					{ key: "Referrer-Policy", value: "same-origin" },
					{ key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
					{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
				],
			},
		];
	},

	/**
	 * Hosts allowed to fetch dev-server resources.
	 *
	 * Development only; ignored in a production build. The server binds `0.0.0.0` so that it
	 * is reachable from other machines on the network — which is how a node on a second
	 * machine is tested — and Next then treats a browser on `127.0.0.1` or a LAN address as a
	 * cross-origin request and refuses to serve it the client bundle. The page renders but
	 * nothing hydrates, with no error in the browser, which is a genuinely confusing failure
	 * to arrive at cold.
	 */
	allowedDevOrigins: ["127.0.0.1", "localhost"],

	/**
	 * Next drops generated rule files into the project root on build unless this is off. They
	 * are not this project's documentation, so they are turned off rather than committed or
	 * repeatedly deleted.
	 */
	agentRules: false,

	experimental: {
		serverActions: {
			/**
			 * Ceiling for a server action's request body.
			 *
			 * Next defaults to 1 MB, which is below even the smallest `assets.maxUploadMb` an
			 * operator could set and would reject a legitimate upload before any of this project's
			 * code saw it — as a framework error page, not as something the Assets tab could word.
			 *
			 * Must stay above `assets.maxUploadMb`'s declared maximum (`SETTINGS` in
			 * `lib/settings/settings-service.ts`, 512 MiB today) with headroom to spare, not merely
			 * above whatever an install currently has it set to: `assets.maxUploadMb` is what
			 * actually decides, enforced in the action and again in the service, so an over-large
			 * upload is refused by this project with this project's message — but only if this
			 * ceiling never becomes the thing that refuses it first. 520 MB leaves room for a
			 * multipart body's own field names and boundaries on top of a file at the setting's
			 * maximum, so a file exactly at that cap is a request slightly over it, and this ceiling
			 * set to the same number would turn the boundary case into the wrong error. Raising
			 * `assets.maxUploadMb`'s maximum without raising this is exactly what
			 * `settings-service.test.ts`'s "assets.maxUploadMb's ceiling" test exists to catch.
			 *
			 * This ceiling is also the memory exposure: Next buffers a server action's body before
			 * this project's own code — the `assets.maxUploadMb` check inside the action, {@link
			 * maxAssetBytes} in `lib/assets/asset-service.ts` — ever runs, so one in-flight upload
			 * can hold up to this many bytes in the server's memory before anything validates it.
			 * `MAX_IMAGE_DIMENSION` bounds the decode that follows a successful upload; it does
			 * nothing for the bytes sitting in memory on the way in, and neither does anything else
			 * in this path. Several uploads at once multiply this figure directly. That was already
			 * true at 16 MB; at 520 MB it is a real amount of memory, and an install expecting to
			 * take concurrent uploads on constrained hardware may want to keep `assets.maxUploadMb`
			 * well under its new 512 MiB ceiling rather than only under whatever this constant is.
			 */
			bodySizeLimit: "520mb",
		},
	},
};

export default nextConfig;
