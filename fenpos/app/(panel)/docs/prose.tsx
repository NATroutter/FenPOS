import Link from "next/link";
import type { ReactNode } from "react";
import { API_ERROR_STATUS, type ApiErrorCode } from "@/lib/errors";

/**
 * The small typographic pieces the reference prose is written with.
 *
 * Distinct from `code-block.tsx`, `contents-rail.tsx` and `doc-section.tsx` beside it, which are
 * the page's structure: these are the units a paragraph is made of. They live here rather than at
 * the bottom of a page module because two pages now write the same prose, and a page module is not
 * something another page may import from.
 */

/**
 * States a millisecond budget in the units a person waiting for it would use.
 *
 * @param ms the budget
 * @returns it in seconds
 */
export function seconds(ms: number): string {
	return `${ms / 1000} seconds`;
}

/**
 * Groups the error codes by the status they map to.
 *
 * Read from the error module rather than restated, so a code added there appears here without
 * anyone remembering to update the docs — the failure mode that makes documentation untrustworthy.
 */
export function groupByStatus(): [number, string[]][] {
	const grouped = new Map<number, string[]>();
	for (const [code, status] of Object.entries(API_ERROR_STATUS)) {
		grouped.set(status, [...(grouped.get(status) ?? []), code]);
	}
	return [...grouped.entries()].sort(([a], [b]) => a - b);
}

/**
 * Colours a status by what the caller should do about it.
 *
 * The same three hues the Jobs tab uses for job state: it worked, you can fix it, the hardware
 * or the server did something. A reader who has seen one screen already knows this vocabulary.
 */
export function statusStyle(status: number): string {
	if (status < 300) {
		return "border-emerald-900 bg-emerald-950 text-emerald-400";
	}
	if (status < 500) {
		return "border-amber-900 bg-amber-950 text-amber-400";
	}
	return "border-destructive/40 bg-destructive/10 text-destructive";
}

/**
 * Explanation beside the thing being explained.
 *
 * A reference laid out as one column is either unreadably wide prose or a narrow ribbon of text
 * with an empty half-page beside it. Putting the prose left and the artifact it describes — the
 * call, the tag table, the permission list — on the right spends the width on something worth
 * reading instead of on margin, and keeps the example in view while the paragraph about it is
 * being read. Stacks below `lg`, where there is only room for one column.
 */
export function Split({ children }: { children: ReactNode }) {
	return <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] lg:items-start">{children}</div>;
}

/** One side of a {@link Split}. */
export function Col({ children }: { children: ReactNode }) {
	return <div className="flex min-w-0 flex-col gap-3">{children}</div>;
}

/**
 * A paragraph of reference prose.
 *
 * Held to about seventy characters. The page used to set prose to the full width of a desktop
 * window, which is roughly a hundred and eighty characters a line — far past the point where the
 * eye reliably finds the start of the next one.
 */
export function P({ children }: { children: ReactNode }) {
	return <p className="text-muted-foreground">{children}</p>;
}

/** A point about why the API behaves as it does, rather than what it does. */
export function Aside({ children }: { children: ReactNode }) {
	return (
		<div className="rounded-lg border border-border border-l-2 border-l-amber-500/50 bg-amber-950/10 px-3 py-2.5 text-muted-foreground">
			{children}
		</div>
	);
}

export function Mono({ children }: { children: ReactNode }) {
	return (
		<code className="rounded border border-border/60 bg-muted px-1 py-0.5 font-mono text-[11.5px] text-foreground/90">
			{children}
		</code>
	);
}

/** An HTTP status referred to inside a sentence. */
export function Status({ children }: { children: ReactNode }) {
	return <span className="font-mono text-[11.5px] font-medium text-emerald-400">{children}</span>;
}

/**
 * An error code, and the status it currently maps to.
 *
 * The status is read from the registry rather than written here. It was written here once, in six
 * places, and every one of them said `400` after the codes moved to `413` and `422` — which is the
 * failure mode that makes documentation untrustworthy: prose that was true when it was typed and
 * that nothing makes false out loud. Typed as `ApiErrorCode`, so a code renamed in `lib/errors.ts`
 * stops this page compiling rather than leaving it describing something that no longer exists.
 */
export function ErrorRef({ code }: { code: ApiErrorCode }) {
	return (
		<>
			<Status>{API_ERROR_STATUS[code]}</Status> <Mono>{code}</Mono>
		</>
	);
}

/**
 * A link from one reference page to a section of the other.
 *
 * Styled as the tag and code chips are rather than as body text, because what it points at is a
 * section of the reference and not a page on the web. Splitting the docs made two of these
 * necessary: a sentence that said "see Blocks below" now has to say where Blocks went.
 */
export function DocLink({ href, children }: { href: string; children: ReactNode }) {
	return (
		<Link
			href={href}
			className="text-sky-300/90 underline decoration-sky-300/40 underline-offset-2 transition-colors hover:text-sky-200 hover:decoration-sky-200"
		>
			{children}
		</Link>
	);
}
