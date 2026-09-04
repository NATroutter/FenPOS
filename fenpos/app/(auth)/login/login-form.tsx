"use client";

import { REGEXP_ONLY_DIGITS_AND_CHARS } from "input-otp";
import { useActionState, useEffect, useState } from "react";
import { type SignInState, signIn, verifyTwoFactor } from "@/app/(auth)/login/actions";
import { PasswordInput } from "@/components/password-input";
import { TurnstileWidget } from "@/components/turnstile-widget";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { Spinner } from "@/components/ui/spinner";

const INITIAL_STATE: SignInState = { error: null, twoFactorRequired: false };

/** How many boxes the authenticator's code gets. TOTP is six digits everywhere this talks to. */
const SIX_DIGITS = 6;

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
 *
 * It renders the card's header as well as its content, which is why the page hands it a bare `Card`.
 * Which step is on screen is client state, and a header left on the server said "Enter your email and
 * password" over a form asking for a six-digit code.
 *
 * @param turnstileSiteKey the public key to render a bot challenge with, or null when the install
 *   has none configured. Only ever the public half — see `turnstileConfig`.
 */
export function LoginForm({ turnstileSiteKey }: { turnstileSiteKey: string | null }) {
	const [signInState, signInAction, signInPending] = useActionState(signIn, INITIAL_STATE);
	const [verifyState, verifyAction, verifyPending] = useActionState(verifyTwoFactor, {
		error: null,
		twoFactorRequired: true,
	});
	const [recoveryCode, setRecoveryCode] = useState(false);

	/**
	 * How many times the password step has come back refused.
	 *
	 * Feeds the widget's `resetKey`. A Turnstile token is single-use, so the one sitting in the form
	 * after a refusal is already spent whatever the refusal was about — a wrong password leaves a
	 * dead token exactly as a failed challenge does, and without this the operator's second, correct
	 * attempt would be refused by Cloudflare for reusing it.
	 *
	 * Counted rather than keyed on the message, because two identical refusals in a row still need
	 * two different tokens.
	 */
	const [refusals, setRefusals] = useState(0);
	useEffect(() => {
		if (signInState.error !== null) {
			setRefusals((count) => count + 1);
		}
	}, [signInState]);

	/**
	 * Cloudflare's own code for why the challenge could not run, once it has said so.
	 *
	 * Without this the page is at its least helpful exactly when it matters most. A site key
	 * Cloudflare refuses means no widget, so no token, so every sign-in on the install comes back
	 * "That challenge could not be verified" — which reads as *you* failed a challenge, when the truth
	 * is nobody can pass one and no password will help. The code is the one thing that says which.
	 */
	const [challengeFailure, setChallengeFailure] = useState<string | null>(null);

	// Once the password has been accepted the challenge is the only thing left to do, and it stays on
	// screen through a refused code — `signInState` is what decides this, and nothing in
	// `verifyTwoFactor`'s own failure path touches it (`verifyState.twoFactorRequired` is never read
	// at all). `verifyState` only ever carries the message for the current attempt.
	if (signInState.twoFactorRequired) {
		return (
			<>
				<CardHeader>
					<CardTitle>Two-factor</CardTitle>
					<CardDescription>
						{recoveryCode
							? "Enter one of the recovery codes you saved."
							: "Enter the six-digit code your authenticator app is showing."}
					</CardDescription>
				</CardHeader>
				<CardContent>
					<form action={verifyAction} className="flex flex-col gap-5">
						{/*
						 * Two shapes of answer post to the same action under the same field name, so the form
						 * is one control or the other rather than both. Six boxes are wrong for a recovery code
						 * — it is neither six characters nor all alphanumeric — and a free-text box is a worse
						 * place to type six digits than six boxes are.
						 *
						 * Neither carries a label. The card's header above is the label: on a screen with one
						 * field, a heading saying "Two-factor" over a field saying "Authentication code" is the
						 * same sentence twice.
						 */}
						{recoveryCode ? (
							<Input
								id="code"
								name="code"
								aria-label="Recovery code"
								autoComplete="one-time-code"
								autoFocus
								maxLength={16}
								required
								className="text-center font-mono"
							/>
						) : (
							<InputOTP
								id="code"
								name="code"
								aria-label="Authentication code"
								maxLength={SIX_DIGITS}
								pattern={REGEXP_ONLY_DIGITS_AND_CHARS}
								autoComplete="one-time-code"
								autoFocus
								required
								containerClassName="justify-center"
							>
								<InputOTPGroup>
									{Array.from({ length: SIX_DIGITS }, (_unused, index) => (
										// biome-ignore lint/suspicious/noArrayIndexKey: the slot's position is its identity.
										<InputOTPSlot key={index} index={index} className="size-11 text-base" />
									))}
								</InputOTPGroup>
							</InputOTP>
						)}

						{verifyState.error ? (
							<Alert variant="destructive">
								<AlertDescription>{verifyState.error}</AlertDescription>
							</Alert>
						) : null}

						<Button type="submit" disabled={verifyPending} className="w-full">
							{verifyPending ? <Spinner /> : null}
							{verifyPending ? "Verifying" : "Continue"}
						</Button>

						{/*
						 * One row, not a stack. Two centred links under a button read as two more buttons and
						 * gave this screen four things to weigh; side by side and small, they read as what they
						 * are — the way out and the way round, neither of them the thing to do next.
						 *
						 * The recovery code is offered here rather than on a page of its own because a lost
						 * phone is exactly when it is reached for.
						 *
						 * "Log out" is a plain anchor, not client-side navigation: the plugin destroys the
						 * challenge cookie after five refused attempts, and every submission after that refuses
						 * with the same message a wrong code gets, with nothing on screen saying the challenge
						 * itself is dead. A full navigation back to this same route remounts the form with
						 * fresh state, which is the only way out short of a refresh nobody is told to try.
						 * Nothing is disclosed by offering it — reaching this screen already proved the
						 * password.
						 */}
						<div className="flex items-center justify-between text-xs text-subtle-foreground">
							<button
								type="button"
								className="underline-offset-4 hover:text-foreground hover:underline"
								onClick={() => setRecoveryCode(!recoveryCode)}
							>
								{recoveryCode ? "Use the code from your app" : "Use a recovery code"}
							</button>
							<a href="/login" className="underline-offset-4 hover:text-foreground hover:underline">
								Log out
							</a>
						</div>
					</form>
				</CardContent>
			</>
		);
	}

	return (
		<>
			<CardHeader>
				<CardTitle>Sign in</CardTitle>
				<CardDescription>Enter your email and password.</CardDescription>
			</CardHeader>
			<CardContent>
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

					{/* Above the messages and the button, which is where it is solved: the challenge is
					    something to finish before submitting, not a result of having submitted. */}
					{turnstileSiteKey ? (
						<TurnstileWidget siteKey={turnstileSiteKey} resetKey={refusals} onUnavailable={setChallengeFailure} />
					) : null}

					{/* Above the refusal below it, because it explains that refusal. Whoever is reading this
					    cannot act on it themselves — the point is to stop them retyping a password that was
					    never the problem, and to name the command for whoever administers the install. */}
					{challengeFailure ? (
						<Alert variant="destructive">
							<AlertDescription className="flex flex-col gap-1">
								<span>
									The bot challenge on this page could not load, so no sign-in here can succeed. This is a problem with
									the install, not with your password.
								</span>
								<span className="text-xs">
									Cloudflare reported <span className="font-mono">{challengeFailure}</span>. An administrator can clear
									it with <span className="font-mono">recover --disable-challenge</span> on the server.
								</span>
							</AlertDescription>
						</Alert>
					) : null}

					{signInState.ban ? (
						<Alert variant="destructive">
							{/*
							 * Two lines, not one sentence. Run together, the expiry broke across a line break
							 * mid-value — "9/4/2026," above "3:00:00 AM" — and the reason ran on from it as
							 * though it were part of the same clause. The timestamp is `whitespace-nowrap` so
							 * it moves as one thing whatever the card's width turns out to be.
							 */}
							<AlertDescription className="flex flex-col gap-1">
								<span>
									This account is banned
									{signInState.ban.until ? (
										<>
											{" until "}
											<span className="whitespace-nowrap">{signInState.ban.until}</span>
										</>
									) : null}
									.
								</span>
								{signInState.ban.reason ? <span>Reason: {signInState.ban.reason}</span> : null}
							</AlertDescription>
						</Alert>
					) : signInState.error ? (
						<Alert variant="destructive">
							<AlertDescription>{signInState.error}</AlertDescription>
						</Alert>
					) : null}

					<Button type="submit" disabled={signInPending} className="w-full">
						{signInPending ? <Spinner /> : null}
						{signInPending ? "Signing in" : "Sign in"}
					</Button>
				</form>
			</CardContent>
		</>
	);
}
