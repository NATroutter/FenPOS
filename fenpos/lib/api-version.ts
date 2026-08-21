/**
 * The version of the public API this server serves.
 *
 * Only the endpoints an integrator calls with an API key are versioned — `print` and `jobs`. Three
 * others under `/api` deliberately are not, and each for its own reason:
 *
 * - `/api/health` is called by a container runtime from a healthcheck line in a compose file, which
 *   nobody wants to edit on a version bump. Liveness is not a contract that evolves.
 * - `/api/events` is the panel talking to itself over a session cookie. It is not reachable with a
 *   key and is not something anyone integrates against.
 * - `/api/pair` is the agent's, and it already negotiates: `PROTOCOL_VERSION` in `lib/link/protocol.ts`
 *   is exchanged at pairing and again on the link's hello frame. Giving that endpoint a second,
 *   independent version axis would mean two answers to one question.
 *
 * Declared here rather than written into each path so the docs, the refusal in the catch-all, and
 * the routes themselves cannot disagree about which version this build serves.
 */

/** The current major version, as it appears in a path. */
export const API_VERSION = "v1";

/** The prefix every versioned endpoint sits behind. */
export const API_BASE = `/api/${API_VERSION}`;
