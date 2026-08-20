"use client";

import { useActionState } from "react";
import { type SetPasswordState, setPassword } from "@/app/(auth)/set-password/actions";
import { PasswordInput } from "@/components/password-input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";

const INITIAL_STATE: SetPasswordState = { error: null };

/**
 * The form that replaces the generated password.
 *
 * Deliberately does not ask for the current password. The operator typed it moments ago to
 * get here and the session proves it; asking again would only invite them to keep the
 * generated one in a clipboard for longer.
 *
 * A client component only for the pending state — every check that matters is in the server
 * action, because a form is not a security boundary.
 */
export function SetPasswordForm() {
	const [state, formAction, pending] = useActionState(setPassword, INITIAL_STATE);

	return (
		<form action={formAction} className="flex flex-col gap-5">
			<Field>
				<FieldLabel htmlFor="password">New password</FieldLabel>
				<PasswordInput
					id="password"
					name="password"
					autoComplete="new-password"
					placeholder="••••••••••••"
					className="font-mono"
					autoFocus
					required
				/>
			</Field>

			<Field>
				<FieldLabel htmlFor="confirm">Confirm new password</FieldLabel>
				<PasswordInput
					id="confirm"
					name="confirm"
					autoComplete="new-password"
					placeholder="••••••••••••"
					className="font-mono"
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
				{pending ? "Saving" : "Set password and continue"}
			</Button>
		</form>
	);
}
