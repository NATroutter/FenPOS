import { redirect } from "next/navigation";
import { AppSidebar } from "@/components/panel/app-sidebar";
import { EventStreamProvider } from "@/components/panel/event-stream";
import { FormatProvider } from "@/components/panel/format-provider";
import { PanelHeader } from "@/components/panel/panel-header";
import { SessionExpiry } from "@/components/panel/session-expiry";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { getAdminProfile, isPasswordGenerated } from "@/lib/auth/admin";
import { avatarInitial, gravatarUrl } from "@/lib/auth/avatar";
import { destroySession } from "@/lib/auth/session";
import { clearSessionCookie, getCurrentSession, readSessionCookie } from "@/lib/auth/session-cookie";
import { APP_VERSION, SERVER_STARTED_AT } from "@/lib/runtime";
import { panelLayoutSettings } from "@/lib/settings/settings-service";

/**
 * Never prerendered: every render depends on the request's session cookie.
 */
export const dynamic = "force-dynamic";

/**
 * Revokes the current session and returns to sign-in.
 *
 * The row is deleted rather than only the cookie cleared, so the token cannot be replayed by
 * anyone who captured it.
 */
async function signOut(): Promise<void> {
	"use server";

	const token = await readSessionCookie();
	if (token) {
		await destroySession(token);
	}
	await clearSessionCookie();
	redirect("/login");
}

/**
 * Shell for every authenticated page.
 *
 * This layout is the authorisation boundary for the panel. The check lives here rather than
 * in middleware because middleware runs on the edge runtime, which has no route to the
 * database — a session could only be checked there by trusting the cookie's contents, which
 * is precisely what server-side sessions exist to avoid. Each page nested under this layout
 * is therefore unreachable without a valid session.
 */
export default async function PanelLayout({ children }: LayoutProps<"/">) {
	const session = await getCurrentSession();
	if (!session) {
		redirect("/login");
	}

	// A session opened with the generated password reaches nothing but the page that replaces
	// it. Enforced here rather than at sign-in because this layout is what every panel page is
	// nested under, so a URL typed straight into the address bar is caught too.
	if (await isPasswordGenerated()) {
		redirect("/set-password");
	}

	// Read here rather than in the sidebar: the footer is part of this layout, and a client
	// component cannot reach the database anyway. One settings read rather than two — see
	// `panelLayoutSettings`.
	const profile = await getAdminProfile();
	const { minimumPasswordLength, formatting } = await panelLayoutSettings();

	return (
		// Outermost, so every descendant — including the sidebar, not just the pages below the
		// header — renders after FormatProvider has pushed the current locale/clock/timezone into
		// the Client Component layer's datetime.ts. See that component's doc comment for why this
		// push, not just applyPushedSettings, is what actually reaches formatDate/formatDateTime's
		// real callers.
		<FormatProvider locale={formatting.locale} hour12={formatting.hour12} timeZone={formatting.timeZone}>
			<SidebarProvider>
				<AppSidebar
					version={APP_VERSION}
					signOutAction={signOut}
					minimumPasswordLength={minimumPasswordLength}
					displayName={profile.displayName}
					email={profile.email}
					avatarUrl={gravatarUrl(profile.email)}
					initial={avatarInitial(profile.displayName)}
				/>
				<SidebarInset className="flex h-screen min-w-0 flex-col overflow-hidden">
					{/* Wraps the header as well as the pages, because the chip that governs the stream
					    lives in the header while everything consuming it is below. */}
					<EventStreamProvider>
						<SessionExpiry expiresAt={session.expiresAt.getTime()} />
						<PanelHeader startedAt={SERVER_STARTED_AT} />
						<div className="flex-1 overflow-y-auto px-6 pt-5 pb-16">{children}</div>
					</EventStreamProvider>
				</SidebarInset>
			</SidebarProvider>
		</FormatProvider>
	);
}
