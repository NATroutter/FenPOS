/**
 * The shape of an API key's secret.
 *
 * Split out of `key-service.ts` because that module is `server-only` and these two values are
 * needed outside a Next request — the demo-data script mints keys the same way the panel does,
 * and a script that carried its own copy of the prefix would produce keys that look right and
 * fail to authenticate. Nothing here imports anything, which is what keeps it usable from a
 * plain `tsx` process.
 *
 * `key-service.ts` remains the definition of record for what a key *is*; this file only records
 * how its secret is written.
 */

/** Prefix every key carries, so one found in a log or a config file is recognisable. */
export const KEY_PREFIX = "fpk_";

/** Characters of the key shown in the panel, so an operator can tell two keys apart. */
export const HINT_LENGTH = 6;
