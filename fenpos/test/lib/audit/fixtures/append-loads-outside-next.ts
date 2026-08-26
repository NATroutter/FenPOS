/**
 * Fixture for `append-loads-outside-next.test.ts`.
 *
 * A plain module, not a `*.test.ts`, so vitest never collects it as a test in its own right — it
 * exists to be handed to a fresh `tsx` process, where `server-only` is not aliased away the way
 * `vitest.config.mts` aliases it for the rest of this suite. Successfully importing
 * `appendAuditEvent` here is the whole assertion; nothing below needs to run it.
 */
import { appendAuditEvent } from "@/lib/audit/append";

void appendAuditEvent;
