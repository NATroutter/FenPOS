import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { LoginForm } from "@/app/(auth)/login/login-form";
import { BrandMark } from "@/components/brand-mark";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { isAdminConfigured } from "@/lib/auth/admin";
import { signInThrottlePhrase } from "@/lib/auth/rate-limit";
import { getCurrentSession } from "@/lib/auth/session-cookie";
import { integerSetting } from "@/lib/settings/settings-service";

export const metadata: Metadata = {
	title: "Sign in",
};

/**
 * Never prerendered: the page decides what to show from the request's session cookie.
 */
export const dynamic = "force-dynamic";

/**
 * Sign-in page.
 *
 * An install with no administrator shows how to bootstrap one rather than offering to set a
 * password here. A web route that can claim an unclaimed install is a takeover waiting to
 * happen on a server that is reachable before anyone configures it, so the first password
 * requires shell access by design.
 */
export default async function LoginPage() {
	if (await getCurrentSession()) {
		redirect("/dashboard");
	}

	const configured = await isAdminConfigured();
	const sessionHours = await integerSetting("auth.sessionHours");
	const signInAttemptsPerMinute = await integerSetting("auth.signInAttemptsPerMinute");

	return (
		<main className="flex min-h-screen items-center justify-center p-6">
			<div className="w-full max-w-[392px]">
				<BrandMark className="mb-5" />

				<Card>
					<CardHeader>
						<CardTitle>Sign in</CardTitle>
						<CardDescription>
							{configured
								? "Enter the administrator password."
								: "No administrator is configured for this install yet."}
						</CardDescription>
					</CardHeader>

					<CardContent>
						{configured ? (
							<LoginForm />
						) : (
							<div className="flex flex-col gap-3 text-sm text-muted-foreground">
								<p>
									A password is generated the first time FenPOS starts and printed to its log. Seeing this instead means
									that step did not complete — the log will say why.
								</p>
								<p className="text-xs">
									If the password is lost, <span className="font-mono text-foreground">pnpm admin:set-password</span>{" "}
									sets a new one from a shell on the server. It is deliberately not available over the web.
								</p>
							</div>
						)}
					</CardContent>
				</Card>

				<p className="mt-3.5 text-xs leading-relaxed text-subtle-foreground">
					Session cookie, {sessionHours} {sessionHours === 1 ? "hour" : "hours"}, HttpOnly ·{" "}
					{signInThrottlePhrase(signInAttemptsPerMinute)}
				</p>
			</div>
		</main>
	);
}
