"use client";

import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import type { GrantableDevice, KeyPermits, KeyRowData } from "@/app/(panel)/keys/key-data";
import { ManageKeyDialog } from "@/app/(panel)/keys/manage-key-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDate, formatDateTime } from "@/lib/format/datetime";
import { cn } from "@/lib/utils";

/** The rows a chip narrows to. `all` is the resting state, not a filter. */
type Filter = "all" | "active" | "revoked";

/**
 * What each chip says and which keys it keeps.
 *
 * Revoked keys are worth a chip of their own where banned accounts are: a revoked key is kept
 * deliberately, so its job history keeps its attribution, and "which of these are dead" is the
 * question a list that keeps its dead is opened with.
 */
const FILTERS: { id: Filter; label: string; matches: (key: KeyRowData) => boolean }[] = [
	{ id: "all", label: "All", matches: () => true },
	{ id: "active", label: "Active", matches: (key) => key.revokedAt === null },
	{ id: "revoked", label: "Revoked", matches: (key) => key.revokedAt !== null },
];

/**
 * Every key as one row, with a single Manage button per row.
 *
 * **A table, not a stack of cards**, and for the reason the Users tab is one: each key used to be a
 * card the height of a paragraph, listing every permission and every printer it holds as its own
 * pill, with six unlabelled icon buttons along the bottom whose only documentation was a `title`
 * attribute. Four keys filled a screen and none of the controls said what it did.
 *
 * The search and the chips are client-side over the rows already rendered. An install has tens of
 * keys, not thousands, and filtering on the server would cost a round trip per keystroke to narrow a
 * list already entirely in the page.
 */
export function KeysTable({
	keys,
	devices,
	permits,
}: {
	keys: KeyRowData[];
	devices: GrantableDevice[];
	permits: KeyPermits;
}) {
	const [query, setQuery] = useState("");
	const [filter, setFilter] = useState<Filter>("all");

	const shown = useMemo(() => {
		const needle = query.trim().toLowerCase();
		const chip = FILTERS.find((entry) => entry.id === filter) ?? FILTERS[0];
		return keys.filter((key) => {
			if (!chip.matches(key)) {
				return false;
			}
			if (needle === "") {
				return true;
			}
			// Permissions and printers are searched too: "which key can reach the kitchen printer" is
			// the question this list is opened with as often as "where is the till key".
			return (
				key.name.toLowerCase().includes(needle) ||
				key.maskedHint.toLowerCase().includes(needle) ||
				key.permissions.some((permission) => permission.toLowerCase().includes(needle)) ||
				key.devices.some((device) => `${device.agentName}/${device.name}`.toLowerCase().includes(needle))
			);
		});
	}, [keys, query, filter]);

	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-wrap items-center gap-1.5">
				{FILTERS.map((entry) => {
					const count = keys.filter(entry.matches).length;
					return (
						<button
							key={entry.id}
							type="button"
							onClick={() => setFilter(entry.id)}
							data-active={entry.id === filter || undefined}
							className={cn(
								"rounded-md border border-transparent px-2.5 py-1 text-[12px] text-muted-foreground transition-colors",
								"hover:bg-accent hover:text-foreground",
								"data-active:border-border data-active:bg-accent data-active:font-medium data-active:text-foreground",
							)}
						>
							{entry.label}
							<span className="ml-1.5 text-subtle-foreground tabular-nums">{count}</span>
						</button>
					);
				})}
			</div>

			<div className="relative">
				<Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-subtle-foreground" />
				<Input
					value={query}
					placeholder="Search by name, hint, permission or printer"
					className="pl-8"
					onChange={(event) => setQuery(event.target.value)}
				/>
			</div>

			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>Key</TableHead>
						<TableHead>Grants</TableHead>
						<TableHead>Webhook</TableHead>
						<TableHead>Created</TableHead>
						<TableHead>Last used</TableHead>
						<TableHead className="w-[96px]" />
					</TableRow>
				</TableHeader>
				<TableBody>
					{shown.length === 0 ? (
						<TableRow>
							<TableCell colSpan={6} className="py-8 text-center text-[12px] text-subtle-foreground">
								No keys match.
							</TableCell>
						</TableRow>
					) : (
						shown.map((key) => (
							<TableRow key={key.id} className={cn(key.revokedAt !== null && "opacity-60")}>
								<TableCell>
									<div className="flex min-w-0 flex-col">
										<span className="truncate font-medium">{key.name}</span>
										<span className="font-mono text-[11px] text-subtle-foreground">…{key.maskedHint}</span>
									</div>
								</TableCell>
								<TableCell>
									<GrantsCell apiKey={key} />
								</TableCell>
								<TableCell className="max-w-[220px] truncate text-subtle-foreground">
									{key.webhook ? key.webhook.url : "—"}
								</TableCell>
								<TableCell className="text-subtle-foreground tabular-nums">{formatDate(key.createdAt)}</TableCell>
								<TableCell className="text-subtle-foreground tabular-nums">
									{key.lastUsedAt === null ? "Never" : formatDateTime(key.lastUsedAt)}
								</TableCell>
								<TableCell className="text-right">
									<ManageKeyDialog
										apiKey={key}
										devices={devices}
										permits={permits}
										trigger={
											<Button variant="outline" size="sm">
												Manage
											</Button>
										}
									/>
								</TableCell>
							</TableRow>
						))
					)}
				</TableBody>
			</Table>
		</div>
	);
}

/**
 * What a key can do, in the space of one cell.
 *
 * A key needs **both** a permission and a printer before it can do anything, so a key missing either
 * is inert — and inert is both the correct state for one just minted and what a misconfigured one
 * looks like. Only a person can tell which, which is why the gap is named in amber rather than
 * shown as a `0` the reader has to notice.
 *
 * Revoked keys say so instead. What a dead key was granted is not what anyone is reading the row
 * for, and an amber warning on one would be a problem being reported about a key that has none.
 */
function GrantsCell({ apiKey }: { apiKey: KeyRowData }) {
	if (apiKey.revokedAt !== null) {
		return <span className="text-destructive">Revoked</span>;
	}
	if (apiKey.permissions.length === 0) {
		return <span className="text-amber-400">No permissions</span>;
	}
	if (apiKey.devices.length === 0) {
		return <span className="text-amber-400">No printers</span>;
	}
	const permissions = apiKey.permissions.length === 1 ? "1 permission" : `${apiKey.permissions.length} permissions`;
	const printers = apiKey.devices.length === 1 ? "1 printer" : `${apiKey.devices.length} printers`;
	return (
		<span className="text-subtle-foreground">
			{permissions} · {printers}
		</span>
	);
}
