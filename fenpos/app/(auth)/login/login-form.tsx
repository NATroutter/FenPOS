"use client";

import { useActionState } from "react";
import { type SignInState, signIn } from "@/app/(auth)/login/actions";
import { PasswordInput } from "@/components/password-input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";

const INITIAL_STATE: SignInState = { error: null };

/**
 * The sign-in form.
 *
 * A client component only because it needs the pending state of the submission; the
 * credential check itself happens entirely in the server action.
 */
export function LoginForm() {
	const [state, formAction, pending] = useActionState(signIn, INITIAL_STATE);

	return (
		<form action={formAction} className="flex flex-col gap-5">
			<Field>
				<FieldLabel htmlFor="password">Password</FieldLabel>
				<PasswordInput
					id="password"
					name="password"
					autoComplete="current-password"
					placeholder="••••••••••••"
					className="font-mono"
					// The page exists to accept one value, so focusing it costs a keyboard user nothing.
					autoFocus
					required
				/>
			</Field>

			{state.error ? (
				<Alert variant="destructive">
					<AlertDescription>{state.error}</AlertDescription>
				</Alert>
			) : null}

			<Button type="submit" disabled={pending} className="w-full">
				{pending ? <Spinner /> : null}
				{pending ? "Signing in" : "Sign in"}
			</Button>
		</form>
	);
}
