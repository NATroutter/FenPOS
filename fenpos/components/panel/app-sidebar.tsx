"use client";

import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { BrandMark } from "@/components/brand-mark";
import { NavUser } from "@/components/panel/nav-user";
import { HEADER_STRIP } from "@/components/panel/panel-header";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupContent,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarMenuSub,
	SidebarMenuSubButton,
	SidebarMenuSubItem,
	SidebarRail,
	useSidebar,
} from "@/components/ui/sidebar";
import { NAV_GROUPS, type NavGroup, type NavItem } from "@/lib/navigation";
import { cn } from "@/lib/utils";

/**
 * The accent bar marking the current section.
 *
 * Styled here rather than in the sidebar primitive because it belongs to this product's
 * navigation, not to every menu button the primitive will ever draw. It earns a strong colour by
 * encoding something true — which page you are on — rather than decorating.
 */
const ACCENT_BAR = cn(
	"relative before:absolute before:top-1/2 before:left-0 before:h-4 before:w-[3px]",
	"before:-translate-y-1/2 before:rounded-full before:bg-brand before:opacity-0",
	"before:transition-opacity data-active:before:opacity-100",
);

/**
 * Whether a path is this section or nested inside it.
 *
 * @param pathname the current route
 * @param href the section's path
 * @returns whether the section owns the path
 */
function owns(pathname: string, href: string): boolean {
	return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Narrows the navigation tree to the sections an account may open.
 *
 * The filtering happens here rather than on the server because a `NavItem` carries `icon`, a
 * function component, and a function cannot cross the server-to-client boundary — React refuses it,
 * fatally, and every page under the panel layout renders "This page couldn't load". So the server
 * sends the permitted paths and this rebuilds the tree around them from its own import.
 *
 * A group left with nothing under it is dropped rather than rendered empty, and a parent's children
 * are filtered the same way — a heading pointing at nothing is worse than no heading.
 *
 * @param permittedHrefs the paths the server decided this account may open
 * @returns the groups to render, in the declared order
 */
function permittedGroups(permittedHrefs: readonly string[]): NavGroup[] {
	const allowed = new Set(permittedHrefs);
	const groups: NavGroup[] = [];

	for (const group of NAV_GROUPS) {
		const items: NavItem[] = [];
		for (const item of group.items) {
			if (!allowed.has(item.href)) {
				continue;
			}
			const children = (item.children ?? []).filter((child) => allowed.has(child.href));
			items.push(item.children ? { ...item, children } : item);
		}
		if (items.length > 0) {
			groups.push({ ...group, items });
		}
	}

	return groups;
}

/**
 * The panel's primary navigation.
 *
 * A client component because the active entry is derived from the current path. Sign-out is
 * a server action passed in from the layout, so this component holds no session logic of its
 * own — and which sections to offer is decided on the server, for the same reason: deciding what a
 * user may see needs the database, and this component cannot reach it.
 */
export function AppSidebar({
	permittedHrefs,
	version,
	signOutAction,
	minimumPasswordLength,
	displayName,
	email,
	avatarUrl,
	initial,
	twoFactorEnabled,
}: {
	/**
	 * The paths this account may open, decided on the server by `permittedNavHrefs`.
	 *
	 * Paths rather than the sections themselves, because a section carries its icon and a function
	 * cannot cross this boundary. This component cannot widen the answer: a path it was not given is
	 * one it does not render. Convenience only — the boundary is each page's own
	 * `requirePagePermission`, because anyone can type a URL.
	 */
	permittedHrefs: readonly string[];
	/** Application version, shown under the wordmark. */
	version: string;
	/** Server action that revokes the session and redirects. */
	signOutAction: () => Promise<void>;
	/** Shortest acceptable password, shown as a hint in the profile dialog. Passed from the
	    server so this client component does not import the argon2-backed password module. */
	minimumPasswordLength: number;
	/** The signed-in user's name, shown in the account menu. */
	displayName: string;
	/** The signed-in user's email. Better Auth requires every account to carry one. */
	email: string;
	/** Resolved on the server, so no address and no hashing reach the browser. */
	avatarUrl: string | null;
	initial: string;
	/**
	 * Whether the account already has a confirmed authenticator. Read on the server so the dialog
	 * opens showing the right of its two states.
	 */
	twoFactorEnabled: boolean;
}) {
	const pathname = usePathname();
	const navGroups = permittedGroups(permittedHrefs);

	return (
		<Sidebar collapsible="icon">
			{/* Same height as the page header beside it, so the two bottom borders read as the one
			    line they appear to be. See HEADER_STRIP. */}
			<SidebarHeader
				className={cn(
					"justify-center overflow-hidden border-b border-sidebar-border px-4 py-3",
					HEADER_STRIP,
					// Collapsed to icons the rail is 48px wide and the lockup is 113px. Left alone the
					// wordmark ran straight out of the sidebar and sat on top of the page title beside
					// it. The tile alone still reads as the product at that width.
					"group-data-[collapsible=icon]:items-center group-data-[collapsible=icon]:px-0",
					"group-data-[collapsible=icon]:[&_[data-slot=brand-name]]:hidden",
				)}
			>
				<BrandMark size="compact" caption={`v${version}`} />
			</SidebarHeader>

			<SidebarContent>
				{navGroups.map((group) => (
					<SidebarGroup key={group.label}>
						<SidebarGroupLabel>{group.label}</SidebarGroupLabel>
						<SidebarGroupContent>
							<SidebarMenu>
								{group.items.map((item) =>
									item.children?.length ? (
										<NavGroupItem key={item.href} item={item} pathname={pathname} />
									) : (
										<SidebarMenuItem key={item.href}>
											<SidebarMenuButton
												isActive={owns(pathname, item.href)}
												className={ACCENT_BAR}
												tooltip={item.label}
												render={
													<Link href={item.href}>
														<item.icon />
														<span>{item.label}</span>
													</Link>
												}
											/>
										</SidebarMenuItem>
									),
								)}
							</SidebarMenu>
						</SidebarGroupContent>
					</SidebarGroup>
				))}
			</SidebarContent>

			<SidebarFooter className="border-t border-sidebar-border">
				<NavUser
					displayName={displayName}
					email={email}
					avatarUrl={avatarUrl}
					initial={initial}
					signOutAction={signOutAction}
					minimumPasswordLength={minimumPasswordLength}
					twoFactorEnabled={twoFactorEnabled}
				/>
			</SidebarFooter>

			<SidebarRail />
		</Sidebar>
	);
}

/**
 * A nav entry that holds other nav entries.
 *
 * The parent is a trigger, not a link: clicking "Docs" opens the group rather than navigating,
 * because with children present there is nothing at `/docs` to navigate to — it redirects.
 *
 * `open` is held in state, re-synced to the path only when it crosses the group's boundary: entering
 * the group opens it, so a link followed from elsewhere never lands you on a page whose section is
 * shut. Re-syncing on entry rather than on every path change is what lets a click close the group
 * while you are still inside it, instead of the URL immediately forcing it back open. Nothing here
 * is persisted — the state resets to whatever the path implies on the next load.
 *
 * The parent carries no accent bar. A parent whose child is active should read as containing the
 * current page, not as being it, so the mark goes on the child's own sub-button instead.
 *
 * No tooltip on the trigger, unlike the leaf entries: `SidebarMenuButton` wraps itself in a
 * `Tooltip` when given one, and that wrapper is not something a `CollapsibleTrigger` can render
 * into. Collapsed-to-icons mode therefore renders a dropdown flyout instead of the collapsible
 * below — that keeps both children reachable at a width with no room for a sub-menu, and gives the
 * icon a label the collapsible trigger could not carry.
 */
function NavGroupItem({ item, pathname }: { item: NavItem; pathname: string }) {
	const { state, isMobile } = useSidebar();
	const children = item.children ?? [];
	const inside = children.some((child) => owns(pathname, child.href));
	const [open, setOpen] = useState(inside);

	// Navigation wins over the toggle, but only when it crosses the group's boundary. Re-synced on
	// `inside` rather than on `pathname` so that following a link INTO the group opens it, while
	// moving between two children does not re-open a group that was just closed by hand.
	useEffect(() => {
		setOpen(inside);
	}, [inside]);

	// Collapsed to icons there is no room for a sub-menu, and the primitive hides it anyway. A
	// flyout keeps both children reachable and gives the icon a label, which the collapsible
	// trigger could not carry: `SidebarMenuButton` given a `tooltip` returns a `<Tooltip>` wrapper
	// that a `CollapsibleTrigger` cannot render into.
	if (state === "collapsed" && !isMobile) {
		return (
			<SidebarMenuItem>
				<DropdownMenu>
					<DropdownMenuTrigger render={<SidebarMenuButton />}>
						<item.icon />
						<span className="sr-only">{item.label}</span>
					</DropdownMenuTrigger>

					<DropdownMenuContent side="right" align="start" sideOffset={4} className="min-w-44">
						<DropdownMenuGroup>
							<DropdownMenuLabel>{item.label}</DropdownMenuLabel>
						</DropdownMenuGroup>
						{children.map((child) => (
							<DropdownMenuItem key={child.href} render={<Link href={child.href} />}>
								<child.icon />
								<span>{child.label}</span>
							</DropdownMenuItem>
						))}
					</DropdownMenuContent>
				</DropdownMenu>
			</SidebarMenuItem>
		);
	}

	return (
		<Collapsible render={<SidebarMenuItem />} open={open} onOpenChange={setOpen}>
			<CollapsibleTrigger
				render={
					<SidebarMenuButton className="group">
						<item.icon />
						<span>{item.label}</span>
						<ChevronRight className="ml-auto size-3.5 text-subtle-foreground transition-transform group-data-[panel-open]:rotate-90" />
					</SidebarMenuButton>
				}
			/>

			<CollapsibleContent>
				<SidebarMenuSub>
					{children.map((child) => (
						<SidebarMenuSubItem key={child.href}>
							<SidebarMenuSubButton
								isActive={owns(pathname, child.href)}
								render={
									<Link href={child.href}>
										<child.icon />
										<span>{child.label}</span>
									</Link>
								}
							/>
						</SidebarMenuSubItem>
					))}
				</SidebarMenuSub>
			</CollapsibleContent>
		</Collapsible>
	);
}
