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
} from "@/components/ui/sidebar";
import { NAV_GROUPS, type NavItem } from "@/lib/navigation";
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
 * The panel's primary navigation.
 *
 * A client component because the active entry is derived from the current path. Sign-out is
 * a server action passed in from the layout, so this component holds no session logic of its
 * own.
 */
export function AppSidebar({
	version,
	signOutAction,
	minimumPasswordLength,
	displayName,
	email,
	avatarUrl,
	initial,
}: {
	/** Application version, shown under the wordmark. */
	version: string;
	/** Server action that revokes the session and redirects. */
	signOutAction: () => Promise<void>;
	/** Shortest acceptable password, shown as a hint in the profile dialog. Passed from the
	    server so this client component does not import the argon2-backed password module. */
	minimumPasswordLength: number;
	/** The administrator's name, shown in the account menu. */
	displayName: string;
	/** Null when none is set, which is also what selects the drawn initial over a Gravatar. */
	email: string | null;
	/** Resolved on the server, so no address and no hashing reach the browser. */
	avatarUrl: string | null;
	initial: string;
}) {
	const pathname = usePathname();

	return (
		<Sidebar>
			{/* Same height as the page header beside it, so the two bottom borders read as the one
			    line they appear to be. See HEADER_STRIP. */}
			<SidebarHeader className={cn("justify-center border-b border-sidebar-border px-4 py-3", HEADER_STRIP)}>
				<BrandMark size="compact" caption={`v${version}`} />
			</SidebarHeader>

			<SidebarContent>
				{NAV_GROUPS.map((group) => (
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
				/>
			</SidebarFooter>
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
 * into. Collapsed-to-icons mode therefore shows this group unlabelled, which is what the sub-menu
 * already does — `SidebarMenuSub` hides itself at that width.
 */
function NavGroupItem({ item, pathname }: { item: NavItem; pathname: string }) {
	const children = item.children ?? [];
	const inside = children.some((child) => owns(pathname, child.href));
	const [open, setOpen] = useState(inside);

	// Navigation wins over the toggle, but only when it crosses the group's boundary. Re-synced on
	// `inside` rather than on `pathname` so that following a link INTO the group opens it, while
	// moving between two children does not re-open a group that was just closed by hand.
	useEffect(() => {
		setOpen(inside);
	}, [inside]);

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
