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
			 * Next defaults to 1 MB, which is below the 2 MB an asset upload is allowed and would
			 * reject a legitimate one before any of this project's code saw it — as a framework
			 * error page, not as something the Assets tab could word.
			 *
			 * Set to twice the real limit rather than to it. `MAX_ASSET_BYTES` in
			 * `lib/assets/asset-service.ts` is what actually decides, and it is enforced in the
			 * action and again in the service, so an over-large upload is refused by this project
			 * with this project's message. The gap is deliberate headroom: a multipart body carries
			 * field names and boundaries beyond the file itself, so a file exactly at the cap is
			 * a request slightly over it, and a framework limit set to the same number would turn
			 * the boundary case into the wrong error. Raising this alone raises nothing.
			 */
			bodySizeLimit: "4mb",
		},
	},
};

export default nextConfig;
