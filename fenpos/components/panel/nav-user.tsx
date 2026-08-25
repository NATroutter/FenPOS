"use client";

import { ChevronsUpDown, LogOut, Settings2 } from "lucide-react";
import { useState } from "react";
import { ProfileDialog } from "@/components/panel/profile-dialog";
import { Avatar } from "@/components/ui/avatar";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "@/components/ui/sidebar";

/**
 * The signed-in user, in the corner of the sidebar.
 *
 * One control where there were three. The name, the profile dialog and sign-out used to sit side
 * by side in a row that had to shrink to fit them; collapsed to icons there is no room for a row
 * at all. A menu costs one click and gives every entry a full-width label at any sidebar width.
 *
 * The dialog is a sibling of the menu rather than a child of it. Rendered inside the menu's
 * content it would unmount the moment the item that opened it was chosen, which is the moment the
 * menu closes.
 */
export function NavUser({
	displayName,
	email,
	avatarUrl,
	initial,
	signOutAction,
	minimumPasswordLength,
}: {
	displayName: string;
	/** The signed-in user's email. Better Auth requires every account to carry one. */
	email: string;
	/** Resolved on the server, so no address and no hashing reach the browser. */
	avatarUrl: string | null;
	initial: string;
	signOutAction: () => Promise<void>;
	minimumPasswordLength: number;
}) {
	const [profileOpen, setProfileOpen] = useState(false);
	const { isMobile } = useSidebar();

	return (
		<>
			<SidebarMenu>
				<SidebarMenuItem>
					<DropdownMenu>
						<DropdownMenuTrigger
							render={
								<SidebarMenuButton
									size="lg"
									className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
								/>
							}
						>
							<Avatar src={avatarUrl} initial={initial} />
							<div className="grid flex-1 text-left leading-tight">
								<span className="truncate text-[12.5px] font-semibold">{displayName}</span>
								<span className="truncate text-[11px] text-subtle-foreground">{email}</span>
							</div>
							<ChevronsUpDown className="ml-auto size-3.5 text-subtle-foreground" />
						</DropdownMenuTrigger>

						<DropdownMenuContent className="min-w-56" side={isMobile ? "bottom" : "right"} align="end" sideOffset={4}>
							{/* base-ui's GroupLabel needs a Group ancestor to read its context from, unlike Radix's
							    standalone label. */}
							<DropdownMenuGroup>
								<DropdownMenuLabel className="p-0 font-normal">
									<div className="flex items-center gap-2 px-1 py-1.5">
										<Avatar src={avatarUrl} initial={initial} />
										<div className="grid flex-1 text-left leading-tight">
											<span className="truncate text-[12.5px] font-semibold">{displayName}</span>
											<span className="truncate text-[11px] text-subtle-foreground">{email}</span>
										</div>
									</div>
								</DropdownMenuLabel>
							</DropdownMenuGroup>

							<DropdownMenuSeparator />

							<DropdownMenuItem onClick={() => setProfileOpen(true)}>
								<Settings2 className="size-3.5" />
								Profile settings
							</DropdownMenuItem>

							<DropdownMenuSeparator />

							{/* Still a form submission rather than an onSelect handler, so signing out keeps
							    working without JavaScript and the server action itself is untouched. */}
							<form action={signOutAction}>
								<DropdownMenuItem nativeButton render={<button type="submit" className="w-full" />}>
									<LogOut className="size-3.5" />
									Sign out
								</DropdownMenuItem>
							</form>
						</DropdownMenuContent>
					</DropdownMenu>
				</SidebarMenuItem>
			</SidebarMenu>

			<ProfileDialog
				open={profileOpen}
				onOpenChange={setProfileOpen}
				minimumLength={minimumPasswordLength}
				displayName={displayName}
				email={email}
				avatarUrl={avatarUrl}
				initial={initial}
			/>
		</>
	);
}
