/**
 * Fixture for `append-loads-outside-next.test.ts`.
 *
 * A plain module, not a `*.test.ts`, so vitest never collects it as a test in its own right — it
 * exists to be handed to a fresh `tsx` process, where `server-only` is not aliased away the way
 * `vitest.config.mts` aliases it for the rest of this suite. Successfully importing
 * `appendAuditEvent` and every named export of `lib/auth/recover.ts` here is the whole assertion;
 * nothing below needs to run any of it. `recover.ts` joined this fixture for the same reason it was
 * written in the first place — `pnpm auth:recover` loads it outside Next too, and the same
 * `server-only` regression would break it the same way.
 */
import { appendAuditEvent } from "@/lib/audit/append";
import { clearAllowlist, clearTwoFactor, listAccounts, resetPassword, unlockAccount } from "@/lib/auth/recover";

void appendAuditEvent;
void listAccounts;
void resetPassword;
void clearTwoFactor;
void unlockAccount;
void clearAllowlist;
