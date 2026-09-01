"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { startTwoFactor } from "@/app/(panel)/settings/actions";
import { type EnrolmentMaterial, TwoFactorSetupDialog } from "@/components/panel/two-factor-setup-dialog";
import { PasswordInput } from "@/components/password-input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";

/**
 * The enrolment gate's own form: a password, a button, and the way on once it is done.
 *
 * `/enrol-2fa`'s only client component. It is not shared with the profile dialog — that reaches
 * two-factor through a button on its Account panel and a password prompt of its own, because a
 * password box sitting on a settings panel reads as a setting. Here the whole page is the ask, so
 * the field belongs on it.
 *
 * There is no "turn it off" for the same reason there is no way past this page: the install requires
 * a second factor, so removing one would send the operator straight back here.
 *
 * Everything between pressing the button and having a working authenticator — the recovery codes,
 * the QR, the code box — belongs to {@link TwoFactorSetupDialog}, which stages it so the codes are
 * read before the QR appears.
 *
 * **The dialog is rendered outside the `enabled` branch, and that is load-bearing.** Confirming an
 * enrolment writes a new session cookie, which makes Next re-render the current route before replying
 * (see `lib/auth/auth-headers.ts`) — so this component re-renders with `enabled` newly true while the
 * dialog is still up. A dialog rendered inside the not-enrolled branch would be unmounted by that
 * render, mid-confirmation, taking the recovery codes with it.
 *
 * @param enabled whether the account already has a confirmed authenticator
 */
export function TwoFactorPanel({ enabled }: { enabled: boolean }) {
	const router = useRouter();
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [enrolment, setEnrolment] = useState<EnrolmentMaterial | null>(null);
	const [setupOpen, setSetupOpen] = useState(false);
	const [pending, startTransition] = useTransition();

	const begin = (): void => {
		setError(null);
		startTransition(async () => {
			const result = await startTwoFactor(password);
			if (result.error || !result.enrolment) {
				setError(result.error ?? "Two-factor could not be set up.");
				return;
			}
			setPassword("");
			setEnrolment(result.enrolment);
			setSetupOpen(true);
		});
	};

	return (
		<>
			<TwoFactorSetupDialog
				open={setupOpen}
				onOpenChange={setSetupOpen}
				enrolment={enrolment}
				onDone={() => {
					// The enrolment is confirmed, so the material can go — and there is nothing behind this
					// page to go back to, because the operator was sent here instead of the panel. Finishing
					// the enrolment is what lets them in.
					setEnrolment(null);
					router.push("/dashboard");
				}}
			/>
			{enabled ? (
				<div className="flex min-w-0 flex-1 flex-col gap-4">
					<p className="text-sm text-muted-foreground">
						Two-factor is on. This account now asks for a code from your authenticator every time you sign in.
					</p>
					<div>
						<Button type="button" onClick={() => router.push("/dashboard")}>
							Continue to the panel
						</Button>
					</div>
				</div>
			) : (
				<div className="flex min-w-0 flex-1 flex-col gap-4">
					<p className="text-sm text-muted-foreground">
						An authenticator app on your phone produces a six-digit code that changes every thirty seconds. With one set
						up, knowing your password is not enough to sign in as you.
					</p>
					<Field>
						<FieldLabel htmlFor="tfa-on-password">Current password</FieldLabel>
						<PasswordInput
							id="tfa-on-password"
							autoComplete="current-password"
							value={password}
							disabled={pending}
							onChange={(event) => setPassword(event.target.value)}
						/>
						<FieldDescription>
							Asked for even though you are signed in — a session left open on an unattended machine is the case this
							defends against.
						</FieldDescription>
					</Field>
					{error ? (
						<Alert variant="destructive">
							<AlertDescription>{error}</AlertDescription>
						</Alert>
					) : null}
					<div>
						<Button type="button" disabled={pending || password === ""} onClick={begin}>
							{pending ? <Spinner className="size-3.5" /> : null}
							Set up two-factor
						</Button>
					</div>
				</div>
			)}
		</>
	);
}
