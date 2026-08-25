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
 * The form that replaces a password the account is required to change.
 *
 * Deliberately does not ask for the current password. The caller typed it moments ago to get
 * here and the session proves it; see `actions.ts` for why that is a different situation from
 * the Settings form, which does ask.
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
