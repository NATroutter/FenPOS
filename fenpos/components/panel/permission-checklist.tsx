"use client";

import { Checkbox } from "@/components/ui/checkbox";
import { FieldLabel } from "@/components/ui/field";
import { grantablePermissionGroups, type PanelPermission } from "@/lib/domain/panel-permissions";

/**
 * The permission list, as both the account and the role screens render it.
 *
 * Rendered from {@link grantablePermissionGroups} rather than from the full set, which is what makes
 * "no checkbox for a permission no grant can confer" a property of the data instead of a rule two
 * forms have to remember separately.
 *
 * **A locked row is checked and disabled, with the reason beside it.** Two things arrive that way and
 * they mean different things, which is why the reason is a string rather than a flag: a permission a
 * role already confers is not the account's own grant to remove here, and a permission the editor
 * does not hold themselves is not theirs to touch at all. Both are shown rather than hidden — an
 * account's authority is not answerable from a form that omits half of it.
 */

/** One permission the form shows but will not let this editor change, and why. */
export interface LockedPermission {
	id: string;
	/** Shown beside the checkbox. One short phrase: "via Printer minder", "you do not hold this". */
	reason: string;
}

/**
 * Renders the grantable permissions as a checklist.
 *
 * @param selected the permissions currently ticked, as individual grants
 * @param locked permissions shown ticked and disabled, each with its reason
 * @param disabled whether the whole list is inert, while a save is in flight
 * @param onToggle called with the permission whose checkbox was clicked
 */
export function PermissionChecklist({
	selected,
	locked,
	disabled,
	onToggle,
}: {
	selected: string[];
	locked: LockedPermission[];
	disabled: boolean;
	onToggle: (permission: PanelPermission) => void;
}) {
	const lockedById = new Map(locked.map((entry) => [entry.id, entry.reason]));

	return (
		<div className="flex flex-col gap-4">
			{grantablePermissionGroups().map((group) => (
				<div key={group.label} className="flex flex-col gap-2.5">
					<span className="text-[12.5px] font-medium">{group.label}</span>
					{group.permissions.map((permission) => {
						const lock = lockedById.get(permission.id);
						return (
							<div key={permission.id} className="flex items-start gap-2.5">
								<Checkbox
									id={`grant-${permission.id}`}
									className="mt-0.5"
									checked={lock !== undefined || selected.includes(permission.id)}
									disabled={disabled || lock !== undefined}
									onCheckedChange={() => onToggle(permission.id)}
								/>
								{/* Stacked rather than laid out in a row: every id begins at the same x, and a
								    description that wraps does so under itself rather than pushing its id off
								    the checkbox it belongs to. The same reasoning `key-dialog.tsx` states. */}
								<FieldLabel
									htmlFor={`grant-${permission.id}`}
									className="w-full cursor-pointer flex-col items-start gap-0.5 font-normal"
								>
									<span className="font-mono text-[12px]">
										{permission.id}
										{lock ? <span className="ml-2 font-sans text-[11px] text-subtle-foreground">{lock}</span> : null}
									</span>
									<span className="text-[11.5px] font-normal text-subtle-foreground">{permission.description}</span>
								</FieldLabel>
							</div>
						);
					})}
				</div>
			))}
		</div>
	);
}
