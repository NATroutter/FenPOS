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
};

export default nextConfig;
