import { redirect } from "next/navigation";
import { AppSidebar } from "@/components/panel/app-sidebar";
import { EventStreamProvider } from "@/components/panel/event-stream";
import { PanelHeader } from "@/components/panel/panel-header";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { isPasswordGenerated } from "@/lib/auth/admin";
import { MINIMUM_PASSWORD_LENGTH } from "@/lib/auth/password";
import { destroySession } from "@/lib/auth/session";
import { clearSessionCookie, getCurrentSession, readSessionCookie } from "@/lib/auth/session-cookie";
import { APP_VERSION, SERVER_STARTED_AT } from "@/lib/runtime";

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
	if (!(await getCurrentSession())) {
		redirect("/login");
	}

	// A session opened with the generated password reaches nothing but the page that replaces
	// it. Enforced here rather than at sign-in because this layout is what every panel page is
	// nested under, so a URL typed straight into the address bar is caught too.
	if (await isPasswordGenerated()) {
		redirect("/set-password");
	}

	return (
		<SidebarProvider>
			<AppSidebar version={APP_VERSION} signOutAction={signOut} minimumPasswordLength={MINIMUM_PASSWORD_LENGTH} />
			<SidebarInset className="flex h-screen min-w-0 flex-col overflow-hidden">
				{/* Wraps the header as well as the pages, because the chip that governs the stream
				    lives in the header while everything consuming it is below. */}
				<EventStreamProvider>
					<PanelHeader startedAt={SERVER_STARTED_AT} />
					<div className="flex-1 overflow-y-auto px-6 pt-5 pb-16">{children}</div>
				</EventStreamProvider>
			</SidebarInset>
		</SidebarProvider>
	);
}
