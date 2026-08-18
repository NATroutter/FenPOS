import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { LoginForm } from "@/app/(auth)/login/login-form";
import { BrandMark } from "@/components/brand-mark";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { isAdminConfigured } from "@/lib/auth/admin";
import { SESSION_TTL_MS } from "@/lib/auth/session";
import { getCurrentSession } from "@/lib/auth/session-cookie";

export const metadata: Metadata = {
	title: "Sign in · FenPOS",
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
	const sessionHours = Math.round(SESSION_TTL_MS / 3_600_000);

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
								<p>Set the first password from a shell on the server:</p>
								<code className="rounded-md border border-border bg-background px-3 py-2 font-mono text-xs text-foreground">
									pnpm admin:set-password &quot;your password&quot;
								</code>
								<p className="text-xs">
									The same command recovers access if the password is lost. It is deliberately not available over the
									web.
								</p>
							</div>
						)}
					</CardContent>
				</Card>

				<p className="mt-3.5 text-xs leading-relaxed text-subtle-foreground">
					Session cookie, {sessionHours} hours, HttpOnly · five attempts per minute
				</p>
			</div>
		</main>
	);
}
