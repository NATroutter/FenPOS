import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SetPasswordForm } from "@/app/(auth)/set-password/set-password-form";
import { BrandMark } from "@/components/brand-mark";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { isPasswordGenerated } from "@/lib/auth/admin";
import { MINIMUM_PASSWORD_LENGTH } from "@/lib/auth/password";
import { getCurrentSession } from "@/lib/auth/session-cookie";

export const metadata: Metadata = {
	title: "Set a password",
};

/** Never prerendered: what this page should do depends on the session and the stored credential. */
export const dynamic = "force-dynamic";

/**
 * The gate between signing in with the generated password and reaching the panel.
 *
 * Sits outside the panel shell — no sidebar, no navigation — because there is nowhere else to
 * go from here. An operator who signed in with a credential that was printed to a log has not
 * finished setting the install up, and letting them wander into the panel first is how that
 * password survives for months.
 *
 * The check that enforces this lives in the panel layout, not here: this page only decides
 * whether to render itself. Guarding the destination rather than the signpost is what makes
 * the rule hold for a link typed straight into the address bar.
 */
export default async function SetPasswordPage() {
	if (!(await getCurrentSession())) {
		redirect("/login");
	}

	if (!(await isPasswordGenerated())) {
		redirect("/dashboard");
	}

	return (
		<main className="flex min-h-screen items-center justify-center p-6">
			<div className="w-full max-w-[392px]">
				<BrandMark className="mb-5" />

				<Card>
					<CardHeader>
						<CardTitle>Choose a password</CardTitle>
						<CardDescription>
							You signed in with the password FenPOS generated and printed to its log. Replace it to continue.
						</CardDescription>
					</CardHeader>

					<CardContent>
						<SetPasswordForm />
					</CardContent>
				</Card>

				<p className="mt-3.5 text-xs leading-relaxed text-subtle-foreground">
					At least {MINIMUM_PASSWORD_LENGTH} characters · the generated password stops working once this is set
				</p>
			</div>
		</main>
	);
}
