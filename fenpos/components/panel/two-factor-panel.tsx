"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { confirmTwoFactor, startTwoFactor, stopTwoFactor } from "@/app/(panel)/settings/actions";
import { PasswordInput } from "@/components/password-input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

/**
 * Enrolling an authenticator, in the three states the flow actually has.
 *
 * Rendered by the profile dialog's Two-factor category, as a standalone component rather than
 * markup inline in the dialog — the three states are enough logic that keeping them here is what
 * lets the dialog's own switch stay a one-line case per category.
 *
 * The QR arrives as markup from the server and is inlined. It is drawn by bwip-js from a URI the
 * server has just minted — not fetched, not from a third party, and never sent anywhere. That is
 * the whole reason it is not an `<img src="https://...">` to a QR service, which is how a shared
 * secret ends up in somebody else's access log.
 *
 * **Confirming does not take the recovery codes off the screen.** The codes are handed over once —
 * the panel stores them encrypted and has no path that shows them again — so an operator who had not
 * yet copied them when they pressed the button would have lost them for good, and losing a phone
 * after that means an administrator has to clear the enrolment. The third state below is what
 * replaces that: two-factor is on, the codes are still there, and the operator says when they are
 * done with them.
 */
export function TwoFactorPanel({ enabled }: { enabled: boolean }) {
	const [password, setPassword] = useState("");
	const [code, setCode] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [qrSvg, setQrSvg] = useState<string | null>(null);
	const [totpUri, setTotpUri] = useState<string | null>(null);
	const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
	const [justEnrolled, setJustEnrolled] = useState(false);
	const [pending, startTransition] = useTransition();

	const begin = (): void => {
		setError(null);
		startTransition(async () => {
			const result = await startTwoFactor(password);
			if (result.error || !result.enrolment) {
				setError(result.error ?? "Two-factor could not be set up.");
				return;
			}
			setQrSvg(result.enrolment.qrSvg);
			setTotpUri(result.enrolment.totpUri);
			setRecoveryCodes(result.enrolment.recoveryCodes);
			setPassword("");
		});
	};

	const confirm = (): void => {
		setError(null);
		startTransition(async () => {
			const result = await confirmTwoFactor(code);
			if (result.error) {
				setError(result.error);
				return;
			}
			// The QR and the typed code are spent; the recovery codes deliberately are not. They are
			// shown once in the account's lifetime, and clearing them here is how an operator who had
			// not copied them yet loses them permanently.
			setQrSvg(null);
			setTotpUri(null);
			setCode("");
			setJustEnrolled(true);
			toast.success("Two-factor is on.");
		});
	};

	const stop = (): void => {
		setError(null);
		startTransition(async () => {
			const result = await stopTwoFactor(password);
			if (result.error) {
				setError(result.error);
				return;
			}
			setPassword("");
			toast.success("Two-factor is off.");
		});
	};

	// Ahead of the `enabled` branch, and that ordering is the point: the server has just been told the
	// account is enrolled, so `enabled` is true by the time this renders. Checking it first would swap
	// the codes for the "turn it off" form in the same breath as issuing them.
	if (justEnrolled && recoveryCodes) {
		return (
			<div className="flex min-w-0 flex-1 flex-col gap-4">
				<p className="text-sm text-muted-foreground">
					Two-factor is on. This account now asks for a code from your authenticator every time you sign in.
				</p>
				<Field>
					<span className="text-sm leading-none font-medium select-none">Recovery codes</span>
					<RecoveryCodeList codes={recoveryCodes} />
					<FieldDescription>
						Last chance: these are not shown again. Each one signs you in once if you lose the app — the panel stores
						them encrypted, and nothing here decrypts them, so there is no screen that can show them to you a second
						time. Without them, an administrator has to clear the enrolment for you.
					</FieldDescription>
				</Field>
				<div>
					<Button
						type="button"
						variant="outline"
						onClick={() => {
							setRecoveryCodes(null);
							setJustEnrolled(false);
						}}
					>
						I have written these down
					</Button>
				</div>
			</div>
		);
	}

	if (enabled) {
		return (
			<div className="flex min-w-0 flex-1 flex-col gap-4">
				<p className="text-sm text-muted-foreground">
					This account asks for a code from your authenticator every time you sign in.
				</p>
				<Field>
					<FieldLabel htmlFor="tfa-off-password">Current password</FieldLabel>
					<PasswordInput
						id="tfa-off-password"
						autoComplete="current-password"
						value={password}
						disabled={pending}
						onChange={(event) => setPassword(event.target.value)}
					/>
					<FieldDescription>
						Asked for because this is the one change here that makes the account easier to reach.
					</FieldDescription>
				</Field>
				{error ? (
					<Alert variant="destructive">
						<AlertDescription>{error}</AlertDescription>
					</Alert>
				) : null}
				<div>
					<Button type="button" variant="destructive" disabled={pending || password === ""} onClick={stop}>
						{pending ? <Spinner className="size-3.5" /> : null}
						Turn two-factor off
					</Button>
				</div>
			</div>
		);
	}

	if (qrSvg && recoveryCodes) {
		return (
			<div className="flex min-w-0 flex-1 flex-col gap-4">
				<Field>
					<span className="text-sm leading-none font-medium select-none">Scan this</span>
					{/*
					 * The markup comes from `totpQr` on the server, which passes a URI this server minted
					 * to bwip-js. Nothing here is user-supplied and nothing here came off the network.
					 */}
					<div
						className="w-44 bg-white p-2 [&>svg]:h-auto [&>svg]:w-full"
						dangerouslySetInnerHTML={{ __html: qrSvg }}
					/>
					<FieldDescription>
						Cannot scan? Enter this key by hand: <code className="break-all">{secretOf(totpUri)}</code>
					</FieldDescription>
				</Field>

				<Field>
					<span className="text-sm leading-none font-medium select-none">Recovery codes</span>
					<RecoveryCodeList codes={recoveryCodes} />
					<FieldDescription>
						Write these down now. Each one signs you in once if you lose the app, and they are not shown again — the
						panel stores them encrypted, not in the clear. Without them, an administrator has to clear the enrolment for
						you.
					</FieldDescription>
				</Field>

				<Field>
					<FieldLabel htmlFor="tfa-code">Code from the app</FieldLabel>
					<Input
						id="tfa-code"
						inputMode="numeric"
						autoComplete="one-time-code"
						maxLength={8}
						value={code}
						disabled={pending}
						onChange={(event) => setCode(event.target.value)}
					/>
					<FieldDescription>Two-factor is not on until a code from the app is accepted.</FieldDescription>
				</Field>

				{error ? (
					<Alert variant="destructive">
						<AlertDescription>{error}</AlertDescription>
					</Alert>
				) : null}

				<div>
					<Button type="button" disabled={pending || code === ""} onClick={confirm}>
						{pending ? <Spinner className="size-3.5" /> : null}
						Turn two-factor on
					</Button>
				</div>
			</div>
		);
	}

	return (
		<div className="flex min-w-0 flex-1 flex-col gap-4">
			<p className="text-sm text-muted-foreground">
				An authenticator app on your phone produces a six-digit code that changes every thirty seconds. With one set up,
				knowing your password is not enough to sign in as you.
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
	);
}

/**
 * The ten codes, laid out to be copied off the screen.
 *
 * Its own component because the same list is shown twice — once beside the QR and once after the
 * enrolment is confirmed — and the two must not drift apart.
 */
function RecoveryCodeList({ codes }: { codes: string[] }) {
	return (
		<ul className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-sm">
			{codes.map((recoveryCode) => (
				<li key={recoveryCode}>{recoveryCode}</li>
			))}
		</ul>
	);
}

/** The shared secret out of an `otpauth:` URI, for an operator whose phone cannot scan. */
function secretOf(uri: string | null): string {
	if (!uri) {
		return "";
	}
	try {
		return new URL(uri).searchParams.get("secret") ?? "";
	} catch {
		return "";
	}
}
