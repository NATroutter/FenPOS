import { prisma } from "@/lib/db";

/**
 * `GET /api/health` — liveness and readiness for a container runtime.
 *
 * Unauthenticated, because a healthcheck runs before anyone has signed in and a probe that
 * needed a credential would need one stored somewhere to use it. It therefore says as little
 * as possible: whether the process is up and whether its database answers. Counts of agents,
 * devices or jobs would turn a probe into a way to watch an install from outside it.
 *
 * The database round-trip is the point. A process that has started but cannot reach its
 * volume serves HTTP perfectly well while being useless, and reporting that as healthy is how
 * a broken deploy gets left running.
 */

/** Never cached and never prerendered: a cached health check is not a health check. */
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
	try {
		// The cheapest statement that proves the file is open and readable. A count would scan.
		await prisma.$queryRaw`SELECT 1`;
	} catch {
		// Deliberately not the error's text. Whatever went wrong is in the server log, where it
		// is useful; in an unauthenticated response it is a database path or a driver version.
		return Response.json({ status: "unavailable", database: "unreachable" }, { status: 503 });
	}

	return Response.json({ status: "ok", database: "ok" });
}
