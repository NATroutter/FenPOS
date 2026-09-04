/**
 * How many rows one address may cost by being refused.
 *
 * A `401` on `/api/v1/*` is recorded, deliberately: a refusal is the whole reason somebody opens the
 * Logs tab, and a request turned away without a trace is the one an operator asked "why has this
 * till stopped printing" cannot diagnose. But the caller of a keyless request has spent nothing —
 * no credential, no session, no work on this server beyond a hash lookup — and the row it produces
 * is durable. Kept for `logs.retentionDays`, then compressed into an archive kept for
 * `logs.archiveRetentionDays`, which defaults to a year. One HTTP request per row, no floor under
 * how fast they can be sent, and the archives share a volume with the audit database, whose writes
 * fail quietly when the disk is full. So the cost of recording a refusal has to be bounded by
 * something other than the attacker's patience.
 *
 * **Coalesced rather than dropped.** After the first few in a window an address stops getting a row
 * of its own and starts getting counted instead; the next row it does get says how many it stands
 * for. Nothing is lost that an operator was going to read — a hundred identical lines answer the
 * same question the first one did, and "and 4,812 more from this address" answers it better — while
 * a flood costs a bounded number of rows however long it runs.
 *
 * Pure and in-memory, with no timer: the count lives beside the window that produced it and both are
 * dropped when that window expires. Per-process, like every other limiter here, which is right for
 * one self-hosted server and would need a shared store to be right for two.
 */

/** How many rows one address may write per window before its refusals are counted instead. */
const ROWS_PER_WINDOW = 5;

/** How long that budget lasts. */
const WINDOW_MS = 60_000;

/**
 * How many addresses are tracked at once.
 *
 * The keys are client addresses, so an attacker with a range to spend chooses how many there are.
 * Without a ceiling the map is itself the thing being attacked — a memory cost per address, paid by
 * this server, on a request the caller made for free. At the cap the oldest window is dropped, which
 * gives up the coalescing for one address rather than the bound for all of them.
 */
const MAX_TRACKED_ADDRESSES = 10_000;

/** What one address has spent, and what it owes. */
interface Budget {
	/** Rows written in this window. */
	written: number;
	/** Refusals counted but not written, since the last row that was. */
	suppressed: number;
	/** Epoch milliseconds at which this window expires. */
	resetAt: number;
}

/** What to do about one keyless refusal. */
export interface KeylessLogVerdict {
	/** Whether to write a row at all. */
	record: boolean;
	/** How many earlier refusals this row also stands for. Zero on an ordinary row. */
	coalesced: number;
}

const budgets = new Map<string, Budget>();

/**
 * Decides whether a keyless refusal from this address gets its own row.
 *
 * @param address the caller's address
 * @param now current time; injectable so tests need no sleeps
 * @returns whether to record, and how many suppressed refusals the row accounts for
 */
export function claimKeylessLogRow(address: string, now: number = Date.now()): KeylessLogVerdict {
	// Read before the sweep, not after. `evictExpired` drops exactly the entries whose window has
	// closed — which is the entry this call needs to read the debt off, so sweeping first threw the
	// suppressed count away and made every row across a window boundary claim it stood for nothing.
	// Holding the reference is enough: deleting the map entry does not disturb the object.
	const existing = budgets.get(address);
	evictExpired(now);

	if (!existing || existing.resetAt <= now) {
		// A fresh window carries over nothing but the debt: an address that flooded through the last
		// minute and is refused again in this one gets one row saying how much of that minute it spent,
		// which is the line worth reading.
		const coalesced = existing ? existing.suppressed : 0;
		budgets.set(address, { written: 1, suppressed: 0, resetAt: now + WINDOW_MS });
		return { record: true, coalesced };
	}

	if (existing.written >= ROWS_PER_WINDOW) {
		existing.suppressed += 1;
		return { record: false, coalesced: 0 };
	}

	existing.written += 1;
	const coalesced = existing.suppressed;
	existing.suppressed = 0;
	return { record: true, coalesced };
}

/**
 * Drops windows that have expired, and the oldest ones if there are too many.
 *
 * Runs on every call rather than on a timer, so this module owns no background work and needs no
 * shutdown — the same arrangement `RateLimiter` uses, for the same reason.
 *
 * @param now current time
 */
function evictExpired(now: number): void {
	for (const [address, budget] of budgets) {
		if (budget.resetAt <= now) {
			budgets.delete(address);
		}
	}

	// Map iteration is insertion-ordered, so the front of it is the least recently started window.
	while (budgets.size >= MAX_TRACKED_ADDRESSES) {
		const oldest = budgets.keys().next();
		if (oldest.done) {
			return;
		}
		budgets.delete(oldest.value);
	}
}

/** Forgets every tracked address. For tests, which must not inherit each other's windows. */
export function resetKeylessLogBudgets(): void {
	budgets.clear();
}
