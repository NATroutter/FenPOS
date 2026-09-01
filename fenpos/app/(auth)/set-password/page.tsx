import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SetPasswordForm } from "@/app/(auth)/set-password/set-password-form";
import { signOut } from "@/app/sign-out";
import { BrandMark } from "@/components/brand-mark";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { minimumLengthPhrase } from "@/lib/auth/password-policy";
import { currentUser } from "@/lib/auth/require-session";
import { integerSetting } from "@/lib/settings/settings-service";

export const metadata: Metadata = {
	title: "Set a password",
};

/** Never prerendered: what this page should do depends on the caller's session. */
export const dynamic = "force-dynamic";

/**
 * The gate between a forced password reset and reaching the panel.
 *
 * Sits outside the panel shell — no sidebar, no navigation — because there is nowhere else to
 * go from here. An account whose password was reset, or which was created with "Require password
 * reset" ticked, has not finished getting set up, and letting it wander into the panel first is
 * how an unfinished sign-in survives indefinitely.
 *
 * The check that enforces this lives in `require-session.ts`, not here: this page only decides
 * whether to render itself. Guarding the destination rather than the signpost is what makes the
 * rule hold for a link typed straight into the address bar.
 */
export default async function SetPasswordPage() {
	const user = await currentUser();
	if (!user) {
		redirect("/login");
	}

	if (!user.mustChangePassword) {
		redirect("/dashboard");
	}

	const minimumPasswordLength = await integerSetting("auth.minimumPasswordLength");

	return (
		<main className="flex min-h-screen items-center justify-center p-6">
			<div className="w-full max-w-[392px]">
				<BrandMark className="mb-5" />

				<Card>
					<CardHeader>
						<CardTitle>Choose a password</CardTitle>
						<CardDescription>This account is required to set a new password before it can be used.</CardDescription>
					</CardHeader>

					<CardContent>
						<SetPasswordForm />
					</CardContent>
				</Card>

				{/*
				 * The policy on the left, the way out on the right. This page is a gate like
				 * `/enrol-2fa` — outside the panel shell, and `requireSession` sends an account that owes
				 * a password change back here from anywhere else — so without the second half an
				 * operator who reached it on the wrong account had a session and nothing to click but
				 * the thing they could not finish. See `signOut`'s own note.
				 */}
				<div className="mt-3.5 flex items-start justify-between gap-4">
					<p className="text-xs leading-relaxed text-subtle-foreground">
						At least {minimumLengthPhrase(minimumPasswordLength)}
					</p>
					<form action={signOut}>
						<button
							type="submit"
							className="text-xs whitespace-nowrap text-subtle-foreground underline-offset-4 hover:text-foreground hover:underline"
						>
							Log out
						</button>
					</form>
				</div>
			</div>
		</main>
	);
}
