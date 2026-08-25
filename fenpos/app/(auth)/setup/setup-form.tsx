"use client";

import { useActionState, useState } from "react";
import { checkSetupKey, runSetup, type SetupState } from "@/app/(auth)/setup/actions";
import { BrandMark } from "@/components/brand-mark";
import { PasswordInput } from "@/components/password-input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { minimumLengthPhrase } from "@/lib/auth/password-policy";

const INITIAL_KEY_STATE: SetupState = { error: null };
const INITIAL_SETUP_STATE: SetupState = { error: null };

/**
 * The two-step form that claims an install.
 *
 * Wraps its own `Card` — unlike `LoginForm`, which leaves that to its page — because the page
 * here renders only `<SetupForm />`: with two steps sharing one heading, the card's content is
 * what needs to change between them, not the chrome around it.
 *
 * Holding the setup key in state between steps is a usability choice with no security content:
 * `runSetup` passes it straight to `completeSetup`, which re-verifies it inside its own
 * transaction. Nothing here is trusted, and nothing here needs to be.
 */
export function SetupForm({ minimumPasswordLength }: { minimumPasswordLength: number }) {
	const [verifiedKey, setVerifiedKey] = useState<string | null>(null);

	async function verifyKey(previous: SetupState, formData: FormData): Promise<SetupState> {
		const result = await checkSetupKey(previous, formData);
		if (!result.error) {
			const key = formData.get("setupKey");
			if (typeof key === "string") {
				setVerifiedKey(key);
			}
		}
		return result;
	}

	const [keyState, keyAction, keyPending] = useActionState(verifyKey, INITIAL_KEY_STATE);
	const [setupState, setupAction, setupPending] = useActionState(runSetup, INITIAL_SETUP_STATE);
	const [confirmError, setConfirmError] = useState<string | null>(null);

	return (
		<main className="flex min-h-screen items-center justify-center p-6">
			<div className="w-full max-w-[392px]">
				<BrandMark className="mb-5" />

				<Card>
					<CardHeader>
						<CardTitle>Claim this install</CardTitle>
						<CardDescription>
							The setup key was printed to the server&apos;s log when it started. A new one is issued on every restart
							until this install has an account.
						</CardDescription>
					</CardHeader>

					<CardContent>
						{verifiedKey === null ? (
							<form action={keyAction} className="flex flex-col gap-5">
								<Field>
									<FieldLabel htmlFor="setupKey">Setup key</FieldLabel>
									<Input
										id="setupKey"
										name="setupKey"
										autoComplete="off"
										placeholder="XXXX-XXXX-XXXX-XXXX-XXXX"
										className="font-mono"
										// The page exists to accept one value at this step, so focusing it costs a
										// keyboard user nothing.
										autoFocus
										required
									/>
								</Field>

								{keyState.error ? (
									<Alert variant="destructive">
										<AlertDescription>{keyState.error}</AlertDescription>
									</Alert>
								) : null}

								<Button type="submit" disabled={keyPending} className="w-full">
									{keyPending ? <Spinner /> : null}
									{keyPending ? "Checking" : "Continue"}
								</Button>
							</form>
						) : (
							<form
								action={setupAction}
								className="flex flex-col gap-5"
								onSubmit={(event) => {
									const form = event.currentTarget;
									const password = (form.elements.namedItem("password") as HTMLInputElement).value;
									const confirm = (form.elements.namedItem("confirm") as HTMLInputElement).value;

									// A convenience only, for immediacy: `completeSetup` is the actual boundary,
									// and it validates the password on the server regardless of what happens here.
									// It does not itself compare against a confirmation value — there is no such
									// field in its input — so this client check is the only place that match is
									// ever enforced.
									if (password !== confirm) {
										event.preventDefault();
										setConfirmError("The two passwords do not match.");
										return;
									}
									setConfirmError(null);
								}}
							>
								<input type="hidden" name="setupKey" value={verifiedKey} />

								<Field>
									<FieldLabel htmlFor="name">Name</FieldLabel>
									<Input id="name" name="name" autoComplete="name" autoFocus required />
								</Field>

								<Field>
									<FieldLabel htmlFor="email">Email</FieldLabel>
									<Input id="email" name="email" type="email" autoComplete="email" required />
								</Field>

								<Field>
									<FieldLabel htmlFor="password">Password</FieldLabel>
									<PasswordInput
										id="password"
										name="password"
										autoComplete="new-password"
										placeholder="••••••••••••"
										className="font-mono"
										required
									/>
									<FieldDescription>At least {minimumLengthPhrase(minimumPasswordLength)}.</FieldDescription>
								</Field>

								<Field>
									<FieldLabel htmlFor="confirm">Confirm password</FieldLabel>
									<PasswordInput
										id="confirm"
										name="confirm"
										autoComplete="new-password"
										placeholder="••••••••••••"
										className="font-mono"
										required
									/>
								</Field>

								{confirmError || setupState.error ? (
									<Alert variant="destructive">
										<AlertDescription>{confirmError ?? setupState.error}</AlertDescription>
									</Alert>
								) : null}

								<Button type="submit" disabled={setupPending} className="w-full">
									{setupPending ? <Spinner /> : null}
									{setupPending ? "Creating account" : "Create account"}
								</Button>

								<Button
									type="button"
									variant="ghost"
									className="w-full"
									disabled={setupPending}
									onClick={() => {
										setVerifiedKey(null);
										setConfirmError(null);
									}}
								>
									Use a different key
								</Button>
							</form>
						)}
					</CardContent>
				</Card>
			</div>
		</main>
	);
}
