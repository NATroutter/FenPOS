import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { LoginForm } from "@/app/(auth)/login/login-form";
import { BrandMark } from "@/components/brand-mark";
import { Card } from "@/components/ui/card";
import { signInThrottlePhrase } from "@/lib/auth/rate-limit";
import { currentUser } from "@/lib/auth/require-session";
import { isInstallClaimed } from "@/lib/auth/setup-key";
import { integerSetting } from "@/lib/settings/settings-service";

export const metadata: Metadata = {
	title: "Sign in",
};

/**
 * Never prerendered: the page decides what to show from the request's session.
 */
export const dynamic = "force-dynamic";

/**
 * Sign-in page.
 */
export default async function LoginPage() {
	// An install with no accounts has nothing to sign in to, and a form that can never succeed is
	// a dead end. The seal in `lib/auth/setup.ts` is what decides whether setup may proceed; this
	// only decides which page an operator is looking at.
	if (!(await isInstallClaimed())) {
		redirect("/setup");
	}

	if (await currentUser()) {
		redirect("/dashboard");
	}

	const signInAttemptsPerMinute = await integerSetting("auth.signInAttemptsPerMinute");

	return (
		<main className="flex min-h-screen items-center justify-center p-6">
			<div className="w-full max-w-[392px]">
				<BrandMark className="mb-5" />

				{/* The header is the form's, not the page's: which step is on screen is client state, and
				    the title and description change with it. */}
				<Card>
					<LoginForm />
				</Card>

				<p className="mt-3.5 text-xs leading-relaxed text-subtle-foreground">
					{signInThrottlePhrase(signInAttemptsPerMinute)}
				</p>
			</div>
		</main>
	);
}
