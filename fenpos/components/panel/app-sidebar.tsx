"use client";

import { LogOut, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BrandMark } from "@/components/brand-mark";
import { HEADER_STRIP } from "@/components/panel/panel-header";
import { ProfileDialog } from "@/components/panel/profile-dialog";
import { Button } from "@/components/ui/button";
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
} from "@/components/ui/sidebar";
import { NAV_GROUPS } from "@/lib/navigation";
import { cn } from "@/lib/utils";

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
}: {
	/** Application version, shown under the wordmark. */
	version: string;
	/** Server action that revokes the session and redirects. */
	signOutAction: () => Promise<void>;
	/** Shortest acceptable password, shown as a hint in the profile dialog. Passed from the
	    server so this client component does not import the argon2-backed password module. */
	minimumPasswordLength: number;
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
								{group.items.map((item) => {
									const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
									return (
										<SidebarMenuItem key={item.href}>
											<SidebarMenuButton
												isActive={active}
												// The accent bar marking the current section. Styled here rather than in the
												// sidebar primitive because it belongs to this product's navigation, not to
												// every menu button the primitive will ever draw. It earns a strong colour by
												// encoding something true — which page you are on — rather than decorating.
												className={cn(
													"relative before:absolute before:top-1/2 before:left-0 before:h-4 before:w-[3px]",
													"before:-translate-y-1/2 before:rounded-full before:bg-brand before:opacity-0",
													"before:transition-opacity data-active:before:opacity-100",
												)}
												tooltip={item.label}
												render={
													<Link href={item.href}>
														<item.icon />
														<span>{item.label}</span>
													</Link>
												}
											/>
										</SidebarMenuItem>
									);
								})}
							</SidebarMenu>
						</SidebarGroupContent>
					</SidebarGroup>
				))}
			</SidebarContent>

			<SidebarFooter className="border-t border-sidebar-border p-3">
				<div className="flex items-center gap-2.5">
					<ShieldCheck className="size-4 shrink-0 text-subtle-foreground" />
					<div className="min-w-0 flex-1">
						<div className="text-[12.5px] font-semibold">Administrator</div>
					</div>
					<ProfileDialog minimumLength={minimumPasswordLength} />

					<form action={signOutAction}>
						<Button
							type="submit"
							variant="outline"
							size="icon"
							className="size-8"
							title="Sign out"
							aria-label="Sign out"
						>
							<LogOut className="size-3.5" />
						</Button>
					</form>
				</div>
			</SidebarFooter>
		</Sidebar>
	);
}
