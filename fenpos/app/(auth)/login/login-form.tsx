"use client";

import { useActionState } from "react";
import { type SignInState, signIn, verifyTwoFactor } from "@/app/(auth)/login/actions";
import { PasswordInput } from "@/components/password-input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

const INITIAL_STATE: SignInState = { error: null, twoFactorRequired: false };

/**
 * The sign-in form.
 *
 * A client component only because it needs the pending state of the submission; the
 * credential check itself happens entirely in the server action.
 *
 * Two `useActionState`s rather than one, because the two steps post to two different actions with
 * two different shapes of submission. `signInState.twoFactorRequired` is what decides which one is
 * on screen — the email and password fields are replaced outright rather than merely hidden, because
 * a hidden password field a manager could still submit would be a second way into the same action.
 */
export function LoginForm() {
	const [signInState, signInAction, signInPending] = useActionState(signIn, INITIAL_STATE);
	const [verifyState, verifyAction, verifyPending] = useActionState(verifyTwoFactor, {
		error: null,
		twoFactorRequired: true,
	});

	// Once the password has been accepted the challenge is the only thing left to do, and it stays
	// on screen through a refused code — `verifyTwoFactor` keeps the flag set on every refusal.
	if (signInState.twoFactorRequired) {
		return (
			<form action={verifyAction} className="flex flex-col gap-5">
				<Field>
					<FieldLabel htmlFor="code">Authentication code</FieldLabel>
					<Input
						id="code"
						name="code"
						inputMode="numeric"
						autoComplete="one-time-code"
						autoFocus
						maxLength={16}
						required
					/>
					<FieldDescription>
						The six digits from your authenticator app, or one of the recovery codes you saved.
					</FieldDescription>
				</Field>

				{verifyState.error ? (
					<Alert variant="destructive">
						<AlertDescription>{verifyState.error}</AlertDescription>
					</Alert>
				) : null}

				<Button type="submit" disabled={verifyPending} className="w-full">
					{verifyPending ? <Spinner /> : null}
					{verifyPending ? "Verifying" : "Continue"}
				</Button>
			</form>
		);
	}

	return (
		<form action={signInAction} className="flex flex-col gap-5">
			<Field>
				<FieldLabel htmlFor="email">Email</FieldLabel>
				<Input
					id="email"
					name="email"
					type="email"
					autoComplete="username"
					// The page exists to accept credentials, so focusing the first field costs a
					// keyboard user nothing.
					autoFocus
					required
				/>
			</Field>

			<Field>
				<FieldLabel htmlFor="password">Password</FieldLabel>
				<PasswordInput
					id="password"
					name="password"
					autoComplete="current-password"
					placeholder="••••••••••••"
					className="font-mono"
					required
				/>
			</Field>

			{signInState.error ? (
				<Alert variant="destructive">
					<AlertDescription>{signInState.error}</AlertDescription>
				</Alert>
			) : null}

			<Button type="submit" disabled={signInPending} className="w-full">
				{signInPending ? <Spinner /> : null}
				{signInPending ? "Signing in" : "Sign in"}
			</Button>
		</form>
	);
}
