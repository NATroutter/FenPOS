/**
 * The path agents connect to.
 *
 * Kept in its own module, free of any `server-only` import, so the process entry point can
 * route upgrades by path without pulling the database and credential modules into a plain
 * Agent process. Both the entry point and the link implementation read it from here, so the
 * route they agree on cannot drift.
 */
export const AGENT_LINK_PATH = "/api/agent-link";
