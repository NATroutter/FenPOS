import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
	 * Next writes AGENTS.md and CLAUDE.md into the project on build unless this is off. They
	 * are not this project's documentation and nothing here is written for an AI agent to
	 * read, so they are turned off rather than committed or repeatedly deleted.
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
