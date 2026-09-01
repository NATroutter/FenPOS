"use client";

import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { FieldLabel } from "@/components/ui/field";
import { grantablePermissionGroups, type PanelPermission } from "@/lib/domain/panel-permissions";
import { cn } from "@/lib/utils";

/**
 * The permission list, as both the account and the role screens render it.
 *
 * Rendered from {@link grantablePermissionGroups} rather than from the full set, which is what makes
 * "no checkbox for a permission no grant can hand out" a property of the data instead of a rule two
 * forms have to remember separately.
 *
 * **Collapsed groups with a select-all in each.** Fifty checkboxes ticked one at a time is how a
 * role that wants "everything about printers" takes a minute to build and one missed box to be
 * wrong. Each group now opens to show its own rows and carries a Select all; the bar above carries
 * one for the lot. The count on each header is what makes a collapsed group still answerable — you
 * can see a group holds three of eight without opening it.
 *
 * **Stacked, never side by side.** Groups are full width and sit one after another, so opening one
 * pushes the rest down rather than leaving a column of empty space beside a tall open panel.
 *
 * **A locked row is checked and disabled, with the reason beside it.** Two things arrive that way and
 * they mean different things, which is why the reason is a string rather than a flag: a permission a
 * role already gives is not the account's own grant to remove here, and a permission the editor
 * does not hold themselves is not theirs to touch at all. Both are shown rather than hidden — an
 * account's authority is not answerable from a form that omits half of it. Select all skips them: it
 * can only reach what this editor could have ticked by hand.
 */

/** One permission the form shows but will not let this editor change, and why. */
export interface LockedPermission {
	id: string;
	/** Shown beside the checkbox. One short phrase: "via Printer minder", "you do not hold this". */
	reason: string;
}

/**
 * Renders the grantable permissions as collapsible groups of checkboxes.
 *
 * @param selected the permissions currently ticked, as individual grants
 * @param locked permissions shown ticked and disabled, each with its reason
 * @param disabled whether the whole list is inert, while a save is in flight
 * @param onChange called with the whole next list — a group's Select all changes many at once, which
 *   a per-permission callback could only express as a burst of toggles the caller has to reassemble
 */
export function PermissionChecklist({
	selected,
	locked,
	disabled,
	onChange,
	className,
}: {
	selected: string[];
	locked: LockedPermission[];
	disabled: boolean;
	onChange: (permissions: string[]) => void;
	className?: string;
}) {
	const lockedById = new Map(locked.map((entry) => [entry.id, entry.reason]));
	const groups = grantablePermissionGroups();

	// Groups holding something start open, so the list opens showing what is already ticked rather
	// than a wall of closed headers the operator has to go hunting through. Initialised once: a group
	// the operator then closes stays closed, even as they tick things inside it.
	const [openGroups, setOpenGroups] = useState<string[]>(() =>
		groups
			.filter((group) => group.permissions.some((permission) => selected.includes(permission.id)))
			.map((group) => group.label),
	);

	/** Whether this editor could tick or untick this row at all. */
	const changeable = (id: string): boolean => !lockedById.has(id);

	const everyId = groups.flatMap((group) => group.permissions.map((permission) => permission.id));
	const changeableIds = everyId.filter(changeable);
	const chosenCount = everyId.filter((id) => lockedById.has(id) || selected.includes(id)).length;
	const allChosen = changeableIds.length > 0 && changeableIds.every((id) => selected.includes(id));

	/** Adds or removes a set of ids in one go, leaving everything outside it untouched. */
	const setMany = (ids: string[], chosen: boolean): void => {
		const changeableSet = new Set(ids.filter(changeable));
		onChange(
			chosen
				? [...selected.filter((id) => !changeableSet.has(id)), ...changeableSet]
				: selected.filter((id) => !changeableSet.has(id)),
		);
	};

	const toggleOne = (id: PanelPermission): void => {
		onChange(selected.includes(id) ? selected.filter((entry) => entry !== id) : [...selected, id]);
	};

	return (
		<div className={cn("flex flex-col gap-2", className)}>
			<div className="flex items-center gap-3 pb-1">
				<span className="text-[11.5px] text-subtle-foreground">
					{chosenCount} of {everyId.length} selected
				</span>
				<div className="flex-1" />
				<BareButton
					disabled={disabled || changeableIds.length === 0}
					onClick={() => setMany(changeableIds, !allChosen)}
				>
					{allChosen ? "Clear all" : "Select all"}
				</BareButton>
			</div>

			{groups.map((group) => {
				const ids = group.permissions.map((permission) => permission.id);
				const groupChosen = ids.filter((id) => lockedById.has(id) || selected.includes(id)).length;
				const groupChangeable = ids.filter(changeable);
				const groupAll = groupChangeable.length > 0 && groupChangeable.every((id) => selected.includes(id));
				const isOpen = openGroups.includes(group.label);

				return (
					<div key={group.label} className="overflow-hidden rounded-lg border border-border">
						<button
							type="button"
							aria-expanded={isOpen}
							onClick={() =>
								setOpenGroups((current) =>
									current.includes(group.label)
										? current.filter((entry) => entry !== group.label)
										: [...current, group.label],
								)
							}
							className={cn(
								"flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors",
								"hover:bg-accent/60",
								isOpen ? "bg-card-band" : "bg-muted/20",
							)}
						>
							<span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{group.label}</span>
							{/* The count is what makes a closed group still answerable: three of eight is visible
							    without opening it, which is the whole point of collapsing them. */}
							<span
								className={cn(
									"shrink-0 rounded-md px-1.5 py-0.5 text-[11px] tabular-nums",
									groupChosen === 0 ? "text-subtle-foreground" : "bg-brand/15 text-brand",
								)}
							>
								{groupChosen}/{ids.length}
							</span>
							<ChevronDown
								className={cn("size-3.5 shrink-0 text-subtle-foreground transition-transform", isOpen && "rotate-180")}
							/>
						</button>

						{isOpen ? (
							<div className="flex flex-col gap-2.5 border-t border-border px-3 py-3">
								<div>
									<BareButton
										disabled={disabled || groupChangeable.length === 0}
										onClick={() => setMany(groupChangeable, !groupAll)}
									>
										{groupAll ? "Deselect all" : "Select all"}
									</BareButton>
								</div>

								{/* Two columns inside a group, never between groups: a group is a handful of short
								    rows, so one column wastes the width, while two *columns of groups* is what
								    leaves the empty space beside a tall open one. */}
								<div className="grid gap-x-6 gap-y-2.5 sm:grid-cols-2">
									{group.permissions.map((permission) => {
										const lock = lockedById.get(permission.id);
										return (
											<div key={permission.id} className="flex items-start gap-2.5">
												<Checkbox
													id={`grant-${permission.id}`}
													className="mt-0.5"
													checked={lock !== undefined || selected.includes(permission.id)}
													disabled={disabled || lock !== undefined}
													onCheckedChange={() => toggleOne(permission.id)}
												/>
												{/* Stacked rather than laid out in a row: every id begins at the same x, and
												    a description that wraps does so under itself rather than pushing its id
												    off the checkbox it belongs to. The same reasoning `key-dialog.tsx`
												    states. */}
												<FieldLabel
													htmlFor={`grant-${permission.id}`}
													className="w-full cursor-pointer flex-col items-start gap-0.5 font-normal"
												>
													<span className="font-mono text-[12px]">
														{permission.id}
														{lock ? (
															<span className="ml-2 font-sans text-[11px] text-subtle-foreground">{lock}</span>
														) : null}
													</span>
													<span className="text-[11.5px] font-normal text-subtle-foreground">
														{permission.description}
													</span>
												</FieldLabel>
											</div>
										);
									})}
								</div>
							</div>
						) : null}
					</div>
				);
			})}
		</div>
	);
}

/** A link-weight action, for the select-alls. A `Button` here would compete with the checkboxes. */
function BareButton({
	children,
	disabled,
	onClick,
}: {
	children: React.ReactNode;
	disabled: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			disabled={disabled}
			onClick={onClick}
			className="text-[11.5px] text-brand underline-offset-4 hover:underline disabled:pointer-events-none disabled:opacity-50"
		>
			{children}
		</button>
	);
}
