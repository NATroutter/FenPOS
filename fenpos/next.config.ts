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
};

export default nextConfig;
