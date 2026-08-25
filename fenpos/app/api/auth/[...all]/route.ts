import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth/auth";

/**
 * Better Auth's own endpoints.
 *
 * Mounted under `/api/auth` rather than beside the versioned print API on purpose: `/api/v1` is
 * a published contract for machine clients authenticating with API keys, and these routes are
 * the browser's session mechanism. Keeping them apart means the API's catch-all 404 handler
 * (`app/api/[...unknown]/route.ts`) and its rate limiting never see them.
 */
export const { GET, POST } = toNextJsHandler(auth);
