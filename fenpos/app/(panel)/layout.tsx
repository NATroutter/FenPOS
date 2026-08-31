import { redirect } from "next/navigation";
import { AppSidebar } from "@/components/panel/app-sidebar";
import { EventStreamProvider } from "@/components/panel/event-stream";
import { FormatProvider } from "@/components/panel/format-provider";
import { PanelHeader } from "@/components/panel/panel-header";
import { SessionExpiry } from "@/components/panel/session-expiry";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { recordAudit, userActor } from "@/lib/audit/audit-log";
import { AUTH_AUDIT_ACTIONS } from "@/lib/audit/auth-events";
import { requestProvenance } from "@/lib/audit/provenance";
import { auth } from "@/lib/auth/auth";
import { authHeaders } from "@/lib/auth/auth-headers";
import { avatarInitial } from "@/lib/auth/avatar";
import { usersWithAvatars } from "@/lib/auth/avatar-service";
import { permittedNavHrefs } from "@/lib/auth/require-permission";
import { requireSession } from "@/lib/auth/require-session";
import { APP_VERSION, SERVER_STARTED_AT } from "@/lib/runtime";
import { panelLayoutSettings } from "@/lib/settings/settings-service";

/**
 * Never prerendered: every render depends on the request's session cookie.
 */
export const dynamic = "force-dynamic";

/**
 * Revokes the current session and returns to sign-in.
 *
 * Better Auth deletes the session row as part of `signOut`, so the token cannot be replayed by
 * anyone who captured it.
 */
async function signOut(): Promise<void> {
	"use server";

	const requestHeaders = await authHeaders();
	// Read before the session is destroyed: afterwards there is no id to record and no user to
	// attribute the row to.
	const session = await auth.api.getSession({ headers: requestHeaders });

	await auth.api.signOut({ headers: requestHeaders });

	if (session?.user) {
		await recordAudit({
			action: AUTH_AUDIT_ACTIONS.SIGN_OUT,
			outcome: "SUCCESS",
			actor: userActor(session.user),
			provenance: await requestProvenance(session.session.id),
		});
	}

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
	// One call, and it settles three questions: is there a session, does this account owe a
	// password change, and — on an install with no accounts — should this go to setup rather than
	// to a sign-in form that could never succeed. See `require-session.ts`.
	const user = await requireSession();

	// A second call rather than threading `expiresAt` through `requireSession`: that function's
	// job is authorisation, not handing back every field Better Auth happens to expose, and most
	// callers have no use for a session's expiry. Confirmed against `better-auth`'s
	// `getSession` route (`dist/api/routes/session.mjs`) that the session object carries a real
	// `expiresAt: Date` — not a guess or a value the app recomputes itself, which could drift from
	// what the server actually extended the session to.
	//
	// `authHeaders` rather than `headers()`, for the reason `currentUser` gives: when this render is
	// the one Next performs after a server action that replaced the session cookie, the request's own
	// headers still name the session that action deleted, and this would come back null.
	const currentSession = await auth.api.getSession({ headers: await authHeaders() });

	// Read here rather than in the sidebar: the footer is part of this layout, and a client
	// component cannot reach the database anyway. One settings read rather than two — see
	// `panelLayoutSettings`.
	const { minimumPasswordLength, formatting } = await panelLayoutSettings();

	// Decided here rather than in the sidebar: what an account may see needs the database, and the
	// sidebar is a client component. Paths rather than the sections themselves, because a section
	// carries its icon and a function cannot cross this boundary — see `permittedNavHrefs`. This is
	// convenience either way; each page's own gate is the boundary, because anyone can type a URL.
	const permittedHrefs = await permittedNavHrefs(user);

	// A one-element set rather than a dedicated "does this one account have an avatar" query: the
	// service already exists for the users list's many-rows case, and a single id is just the
	// smallest input it accepts.
	const hasAvatar = (await usersWithAvatars([user.id])).has(user.id);

	return (
		// Outermost, so every descendant — including the sidebar, not just the pages below the
		// header — renders after FormatProvider has pushed the current locale/clock/timezone into
		// the Client Component layer's datetime.ts. See that component's doc comment for why this
		// push, not just applyPushedSettings, is what actually reaches formatDate/formatDateTime's
		// real callers.
		<FormatProvider locale={formatting.locale} hour12={formatting.hour12} timeZone={formatting.timeZone}>
			<SidebarProvider>
				<AppSidebar
					permittedHrefs={permittedHrefs}
					version={APP_VERSION}
					signOutAction={signOut}
					minimumPasswordLength={minimumPasswordLength}
					displayName={user.name}
					email={user.email}
					avatarUrl={hasAvatar ? `/api/avatar/${user.id}` : null}
					initial={avatarInitial(user.name)}
					twoFactorEnabled={user.twoFactorEnabled}
				/>
				<SidebarInset className="flex h-screen min-w-0 flex-col overflow-hidden">
					{/* Wraps the header as well as the pages, because the chip that governs the stream
					    lives in the header while everything consuming it is below. */}
					<EventStreamProvider>
						{/* Null only if the session was revoked in the instant between `requireSession`
						    above and the `getSession` call that fetched `expiresAt` — a window too narrow
						    to build a fallback around. Skipping the mount there just means this one render
						    relies solely on the server-side guards until the next navigation. */}
						{currentSession ? <SessionExpiry expiresAt={currentSession.session.expiresAt.getTime()} /> : null}
						<PanelHeader startedAt={SERVER_STARTED_AT} />
						<div className="flex-1 overflow-y-auto px-6 pt-5 pb-16">{children}</div>
					</EventStreamProvider>
				</SidebarInset>
			</SidebarProvider>
		</FormatProvider>
	);
}
