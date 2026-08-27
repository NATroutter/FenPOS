/**
 * Fixture for `append-loads-outside-next.test.ts`.
 *
 * A plain module, not a `*.test.ts`, so vitest never collects it as a test in its own right — it
 * exists to be handed to a fresh `tsx` process, where `server-only` is not aliased away the way
 * `vitest.config.mts` aliases it for the rest of this suite. Successfully importing
 * `appendAuditEvent`, every named export of `lib/auth/recover.ts`, and `verifyAuditChain` here is
 * the whole assertion; nothing below needs to run any of it. `recover.ts` joined this fixture for
 * the same reason it was written in the first place — `pnpm auth:recover` loads it outside Next
 * too, and the same `server-only` regression would break it the same way. `verify.ts` joined for
 * the same reason again: `pnpm audit:verify` loads it outside Next, and this branch grew that
 * module by hundreds of lines and added value imports (`node:fs`, `node:zlib`, `node:os`,
 * `node:stream/promises`, `better-sqlite3`) that a later edit could easily add to alongside one
 * that does carry `server-only` — nothing else in the suite would notice, since vitest aliases
 * `server-only` away.
 */
import { appendAuditEvent } from "@/lib/audit/append";
import { verifyAuditChain } from "@/lib/audit/verify";
import { clearAllowlist, clearTwoFactor, listAccounts, resetPassword, unlockAccount } from "@/lib/auth/recover";

void appendAuditEvent;
void listAccounts;
void resetPassword;
void clearTwoFactor;
void unlockAccount;
void clearAllowlist;
void verifyAuditChain;
