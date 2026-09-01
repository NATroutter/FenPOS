"use client";

import type { ReactElement, ReactNode } from "react";
import { DirtyDot } from "@/components/panel/dirty-dot";
import { cn } from "@/lib/utils";

/**
 * The parts every "manage one record" dialog is built from.
 *
 * Shared rather than copied because the whole point of the Users, Roles and Keys tabs looking alike
 * is that they *are* alike: an operator who has learned that a tinted row means "armed, waiting for
 * Save" has learned it everywhere. Three copies of these forty lines is how one tab quietly grows a
 * different idea of what staged looks like.
 *
 * What is not here is layout. Each dialog decides its own shape — an account is three unrelated
 * things at once and gets two columns; a role is three fields about one thing and gets one — and a
 * shared component that tried to own that would be a component every caller fights.
 */

/** A small uppercase heading over one group of fields or actions. */
export function SectionLabel({ children, destructive = false }: { children: ReactNode; destructive?: boolean }) {
	return (
		<span
			className={cn(
				"text-[10.5px] font-medium tracking-[0.08em] uppercase",
				destructive ? "text-destructive" : "text-subtle-foreground",
			)}
		>
			{children}
		</span>
	);
}

/**
 * One `label: value` line in a read-only facts list.
 *
 * Renders a `dt`/`dd` pair and nothing else, so the caller's own `dl` owns the grid — which is what
 * lets the labels in one list line up without every dialog agreeing on a column width.
 */
export function Fact({ label, children }: { label: string; children: ReactNode }) {
	return (
		<>
			<dt className="text-subtle-foreground">{label}</dt>
			<dd className="min-w-0 truncate">{children}</dd>
		</>
	);
}

/**
 * The one row shape every action on these screens wears.
 *
 * A function rather than copies of the same class string, because rows that do comparable things
 * have to be indistinguishable: the account dialog's Danger zone read as a section with a stray
 * neutral button in it while promoting and lifting a ban were styled one way and banning and
 * deleting another, and the only thing that difference communicated was which of them happened to be
 * a `<button>` and which a dialog trigger — not a distinction an operator has any use for.
 *
 * @param destructive whether the row belongs to a Danger zone
 * @param staged whether the change is armed and waiting for Save
 */
export function actionRowClass({ destructive, staged }: { destructive: boolean; staged: boolean }): string {
	return cn(
		"flex w-full flex-col gap-0.5 rounded-lg border px-3 py-2.5 text-left transition-colors",
		"disabled:pointer-events-none disabled:opacity-50",
		destructive
			? staged
				? "border-destructive bg-destructive/15 text-destructive"
				: "border-destructive/40 text-destructive hover:bg-destructive/10"
			: staged
				? "border-brand/50 bg-brand/5"
				: "border-border bg-muted/30 hover:bg-muted/60",
	);
}

/**
 * One action that arms rather than fires.
 *
 * Clicking it stages the change and tints the row; clicking again disarms it. The state on the right
 * is what the record is *now* — "not enrolled", "3 active", "never used" — which is the reason this
 * is a row and not a bare button: an action that would do nothing to this record is disabled and
 * says why, rather than being hidden and leaving the operator unsure the control exists.
 */
export function StagedAction({
	icon,
	label,
	hint,
	state,
	staged,
	disabled,
	destructive = false,
	onToggle,
}: {
	icon?: ReactElement;
	label: string;
	hint?: string;
	state?: string;
	staged: boolean;
	disabled: boolean;
	destructive?: boolean;
	onToggle: () => void;
}) {
	return (
		<button type="button" disabled={disabled} onClick={onToggle} className={actionRowClass({ destructive, staged })}>
			<span className="flex w-full items-center gap-2 text-[12.5px]">
				{icon ? (
					<span className={cn("shrink-0", destructive ? "text-destructive/70" : "text-subtle-foreground")}>{icon}</span>
				) : null}
				<span className="min-w-0 flex-1 truncate">{label}</span>
				{staged ? <DirtyDot /> : null}
				{state ? (
					<span
						className={cn(
							"shrink-0 text-[10.5px] tracking-[0.06em] uppercase",
							destructive ? "text-destructive/70" : "text-subtle-foreground",
						)}
					>
						{state}
					</span>
				) : null}
			</span>
			{hint ? (
				<span className={cn("text-[11px]", destructive ? "text-destructive/70" : "text-subtle-foreground")}>
					{hint}
				</span>
			) : null}
		</button>
	);
}
