import { closedSet } from "@/lib/domain/enums";

/**
 * Closed value sets belonging to the audit record.
 *
 * Separate from `enums.ts` because that file's contract is that every set in it mirrors an enum in
 * the Java agent, and these never can: the agent has no notion of a panel actor or of a permission
 * refusal. Same shape, same discipline, different contract.
 *
 * **These strings are a stored contract in a stronger sense than most.** Every `AuditEvent` row
 * covers its own `actorKind` and `outcome` in its hash, and there is no edit path. Renaming a value
 * would not migrate the old rows — it would invalidate them.
 */

/**
 * Who did the thing.
 *
 * `SETUP` is not a user: first-run setup happens before any account exists, so its events are
 * attributed to the act rather than to a person. `SYSTEM` is the server acting on its own — a
 * retention sweep, a scheduled job. `CLI` marks an action taken with filesystem access rather than
 * through the panel, which is the one category no session and no permission gates.
 */
export const ActorKind = closedSet(["USER", "API_KEY", "SYSTEM", "SETUP", "CLI"] as const);
export type ActorKind = (typeof ActorKind.values)[number];

/**
 * What came of it.
 *
 * `DENIED` means the actor was refused — a wrong password, a missing permission, a rate limit.
 * `FAILURE` means it was allowed and then broke. Keeping them apart is the whole point of recording
 * failures at all: a log full of `DENIED` rows is somebody probing, and a log full of `FAILURE`
 * rows is something wrong with the install.
 */
export const AuditOutcome = closedSet(["SUCCESS", "DENIED", "FAILURE"] as const);
export type AuditOutcome = (typeof AuditOutcome.values)[number];
