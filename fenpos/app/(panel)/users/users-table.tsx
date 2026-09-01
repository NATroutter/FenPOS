"use client";

import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { ManageUserDialog } from "@/app/(panel)/users/manage-user-dialog";
import type { GrantableRole, UserPermits, UserRowData } from "@/app/(panel)/users/user-data";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDate } from "@/lib/format/datetime";
import { cn } from "@/lib/utils";

/** The rows a chip narrows to. `all` is the resting state, not a filter. */
type Filter = "all" | "superuser" | "banned";

/**
 * What each chip says and which accounts it keeps.
 *
 * There was a "No access" chip here for accounts holding nothing at all. It is gone: the Access
 * column already says so on the row itself, in red, so on a list you can take in at a glance the
 * chip answered a question you had already answered by looking — and it read `0` on an install where
 * every account is set up, which is most of the time.
 */
const FILTERS: { id: Filter; label: string; matches: (account: UserRowData) => boolean }[] = [
	{ id: "all", label: "All", matches: () => true },
	{ id: "superuser", label: "Superusers", matches: (account) => account.isSuperuser },
	{ id: "banned", label: "Banned", matches: (account) => account.banned },
];

/**
 * Every account as one row, with a single Manage button per row.
 *
 * **A table, not a stack of cards.** Each account used to be a card the height of a paragraph with
 * eight unlabelled icon buttons along the bottom, so eight accounts filled a screen and none of the
 * controls said what it did. A row says who somebody is and what they hold at a glance, and the one
 * button opens everything that can be done about them.
 *
 * The search and the chips are client-side over the rows already rendered. This install has tens of
 * accounts, not thousands, and filtering on the server would cost a round trip per keystroke to
 * narrow a list that is already entirely in the page.
 */
export function UsersTable({
	accounts,
	roles,
	editorHolds,
	actingUserId,
	permits,
}: {
	accounts: UserRowData[];
	roles: GrantableRole[];
	editorHolds: string[];
	actingUserId: string;
	permits: UserPermits;
}) {
	const [query, setQuery] = useState("");
	const [filter, setFilter] = useState<Filter>("all");

	const shown = useMemo(() => {
		const needle = query.trim().toLowerCase();
		const chip = FILTERS.find((entry) => entry.id === filter) ?? FILTERS[0];
		return accounts.filter((account) => {
			if (!chip.matches(account)) {
				return false;
			}
			if (needle === "") {
				return true;
			}
			// Roles are searched too: "who is on the till role" is the question this list is opened
			// with as often as "where is Sam".
			return (
				account.name.toLowerCase().includes(needle) ||
				account.email.toLowerCase().includes(needle) ||
				account.roles.some((role) => role.name.toLowerCase().includes(needle))
			);
		});
	}, [accounts, query, filter]);

	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-wrap items-center gap-1.5">
				{FILTERS.map((entry) => {
					const count = accounts.filter(entry.matches).length;
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
					placeholder="Search by name, email or role"
					className="pl-8"
					onChange={(event) => setQuery(event.target.value)}
				/>
			</div>

			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>User</TableHead>
						<TableHead>Email</TableHead>
						<TableHead>Access</TableHead>
						<TableHead>Created</TableHead>
						<TableHead className="text-right">Sessions</TableHead>
						<TableHead className="w-[96px]" />
					</TableRow>
				</TableHeader>
				<TableBody>
					{shown.length === 0 ? (
						<TableRow>
							<TableCell colSpan={6} className="py-8 text-center text-[12px] text-subtle-foreground">
								No accounts match.
							</TableCell>
						</TableRow>
					) : (
						shown.map((account) => (
							<TableRow key={account.id}>
								<TableCell>
									<div className="flex items-center gap-2.5">
										<Avatar src={account.avatarUrl} initial={account.initial} className="size-7 flex-none" />
										<span className="truncate font-medium">{account.name}</span>
										{account.id === actingUserId ? (
											<span className="text-[11px] text-subtle-foreground">you</span>
										) : null}
										{/*
										 * A badge rather than the faded row this replaces. Dimming the whole row said
										 * "banned" only to somebody who already knew that was the convention — to
										 * everybody else it read as disabled, or as still loading — and it did so by
										 * making the name, the address and the access harder to read, which is the
										 * opposite of what you want on the row you have just gone looking for.
										 */}
										{account.banned ? (
											<Badge
												variant="outline"
												className="border-destructive/40 bg-destructive/10 text-[10.5px] text-destructive"
											>
												Banned
											</Badge>
										) : null}
									</div>
								</TableCell>
								<TableCell className="text-subtle-foreground">{account.email}</TableCell>
								<TableCell>
									<AccessCell account={account} />
								</TableCell>
								<TableCell className="text-subtle-foreground tabular-nums">{formatDate(account.createdAt)}</TableCell>
								<TableCell className="text-right tabular-nums">{account.sessionCount}</TableCell>
								<TableCell className="text-right">
									<ManageUserDialog
										account={account}
										roles={roles}
										editorHolds={editorHolds}
										isSelf={account.id === actingUserId}
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
 * What one account can do, in the width of a table cell.
 *
 * A dot and a word rather than a row of badges. The old card listed every role and every individual
 * grant as its own pill, which is the right amount of detail for the manage dialog and far too much
 * for a list you are scanning — the question a row answers is "roughly how much can this person do",
 * and the answer is one line.
 */
function AccessCell({ account }: { account: UserRowData }) {
	if (account.isSuperuser) {
		return (
			<span className="flex items-center gap-1.5">
				<span className="size-1.5 rounded-full bg-amber-400" />
				<span className="text-amber-400">Superuser</span>
			</span>
		);
	}

	if (account.roles.length === 0 && account.permissions.length === 0) {
		return (
			<span className="flex items-center gap-1.5">
				<span className="size-1.5 rounded-full border border-subtle-foreground" />
				<span className="text-subtle-foreground">No access</span>
			</span>
		);
	}

	const named = account.roles.map((role) => role.name);
	const extra = account.permissions.length;

	return (
		<span className="flex items-center gap-1.5">
			<span className="size-1.5 rounded-full bg-brand" />
			<span className="truncate">
				{named.length > 0 ? named.join(", ") : "No role"}
				{extra > 0 ? (
					<span className="ml-1.5 text-subtle-foreground">
						{named.length > 0 ? "+" : ""}
						{extra === 1 ? "1 grant" : `${extra} grants`}
					</span>
				) : null}
			</span>
		</span>
	);
}
