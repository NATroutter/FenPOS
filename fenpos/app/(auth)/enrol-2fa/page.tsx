import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { BrandMark } from "@/components/brand-mark";
import { TwoFactorPanel } from "@/components/panel/two-factor-panel";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { currentUser } from "@/lib/auth/require-session";
import { booleanSetting } from "@/lib/settings/settings-service";

export const metadata: Metadata = {
	title: "Set up two-factor",
};

/**
 * Never prerendered: the page decides what to show from the request's session.
 */
export const dynamic = "force-dynamic";

/**
 * Enrolment, for an install that requires a second factor and an account that has none.
 *
 * Under `(auth)` rather than `(panel)`. The panel layout calls `requireSession`, and `requireSession`
 * is what sends an un-enrolled operator here — a gate page inside the thing it gates would redirect
 * to itself forever. `/set-password` sits here for exactly the same reason.
 *
 * `currentUser` rather than `requireSession`, for that same reason. This page does its own checks
 * instead: signed in at all, owes no password change, still needs to enrol, and the install still
 * requires it.
 */
export default async function EnrolTwoFactorPage() {
	const user = await currentUser();
	if (!user) {
		redirect("/login");
	}

	// Same rank as in `requireSession`: a forced password change outranks enrolment there, so this
	// page must not offer the enrolment form to an account that owes one either — `self:begin-2fa`
	// would refuse it and bounce to `/set-password` anyway, which is correct at the action layer but
	// not a reason to let the form render here first.
	if (user.mustChangePassword) {
		redirect("/set-password");
	}

	// Somebody who typed the URL on an install that does not require a second factor should set one up
	// from their profile like everyone else, rather than through a gate page.
	if (!(await booleanSetting("auth.require2fa"))) {
		redirect("/dashboard");
	}

	// **An enrolled account is deliberately not redirected away.** Confirming an enrolment writes a
	// new session cookie, and Next re-renders the current route before replying — this route, now
	// seeing `twoFactorEnabled` true. A redirect here would fire on that render and unmount
	// `TwoFactorPanel` along with the only display of the recovery codes there will ever be, on the
	// one flow `auth.require2fa` compels. Rendering the panel with the new flag instead leaves the
	// component in place, so its "last chance" screen survives and the operator dismisses it. The way
	// on is inside the panel — see its `gate` prop — because only it knows whether the codes are still
	// on the screen.
	const enrolled = user.twoFactorEnabled;

	return (
		<main className="flex min-h-screen items-center justify-center p-6">
			<div className="w-full max-w-[520px]">
				<BrandMark className="mb-5" />
				<Card>
					<CardHeader>
						<CardTitle>{enrolled ? "Two-factor is on" : "Set up two-factor"}</CardTitle>
						<CardDescription>
							{enrolled
								? "Keep your recovery codes somewhere safe — they are the only way back in if you lose the app."
								: "This install requires an authenticator app. Setting one up is the last thing between you and the panel."}
						</CardDescription>
					</CardHeader>
					<CardContent>
						<TwoFactorPanel enabled={enrolled} gate />
					</CardContent>
				</Card>
			</div>
		</main>
	);
}
