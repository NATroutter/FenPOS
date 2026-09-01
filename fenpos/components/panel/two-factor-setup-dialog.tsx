"use client";

import { REGEXP_ONLY_DIGITS_AND_CHARS } from "input-otp";
import { Check, Copy, TriangleAlert } from "lucide-react";
import { type ReactNode, useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { confirmTwoFactor } from "@/app/(panel)/settings/actions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";

/** What the enrolment screen is handed, structurally — the server type lives in a server-only module. */
export interface EnrolmentMaterial {
	/** The `otpauth:` URI, for an operator whose phone cannot scan. */
	totpUri: string;
	/** That same URI as inline SVG, drawn on the server. */
	qrSvg: string;
	/** The one-time codes that stand in for the authenticator, shown once and never again. */
	recoveryCodes: string[];
}

/**
 * How long the recovery codes stay on screen before the way forward opens, in seconds.
 *
 * The delay is the whole point of the first step. An operator who has been handed ten codes and a
 * button in the same instant presses the button — the codes are a wall of text between them and the
 * thing they came here to do, and the cost of skipping them is invisible until the day they lose
 * their phone. Ten seconds is short enough not to feel like a punishment and long enough that
 * continuing is a second decision rather than the same click.
 */
const DWELL_SECONDS = 10;

/** How many boxes the authenticator's code gets. TOTP is six digits everywhere this talks to. */
const SIX_DIGITS = 6;

/** Which of the two screens the dialog is showing. */
type Stage = "codes" | "scan";

/**
 * Enrolling an authenticator, as a dialog with the recovery codes in front of the QR.
 *
 * Split out of `TwoFactorPanel` and staged deliberately. The codes used to sit *beside* the QR and
 * the code box, which put the one thing on the screen that cannot be reissued next to the two things
 * the operator was actually trying to get through — so the codes were read as decoration and scrolled
 * past. Here they are the first screen, alone, with nothing else to look at and no button to press
 * for {@link DWELL_SECONDS} seconds.
 *
 * The QR only appears once the operator has said they saved them, and the way back to them stays
 * open until the enrolment is confirmed. That first screen and that way back are the whole of the
 * guarantee that the codes were seen — the codes are handed over once, and confirming closes the
 * dialog on them for good.
 *
 * Rendered by the panel rather than by either caller, so `/enrol-2fa` and the profile dialog get the
 * same flow with nothing of their own to keep in sync.
 *
 * @param enrolment the material from `startTwoFactor`, or null before there is any
 * @param onDone told once the server has accepted a code and the second factor is on
 */
export function TwoFactorSetupDialog({
	open,
	onOpenChange,
	enrolment,
	onDone,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	enrolment: EnrolmentMaterial | null;
	onDone: () => void;
}) {
	const [stage, setStage] = useState<Stage>("codes");
	const [remaining, setRemaining] = useState(DWELL_SECONDS);
	const [copied, setCopied] = useState(false);
	const [keyCopied, setKeyCopied] = useState(false);
	const [code, setCode] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [pending, startTransition] = useTransition();

	// A fresh enrolment is a fresh first screen, countdown included. Keyed on `open` rather than on
	// the material: the same object is still in the panel's state while the dialog animates out, and
	// reopening after an abandoned attempt has to start over, not resume where it was left.
	useEffect(() => {
		if (!open) {
			return;
		}
		setStage("codes");
		setRemaining(DWELL_SECONDS);
		setCopied(false);
		setKeyCopied(false);
		setCode("");
		setError(null);
	}, [open]);

	// A tick that stays ticked is a button that looks disabled. Both copy controls fall back to their
	// own icon shortly after being pressed, so the confirmation reads as something that happened
	// rather than as the control's new resting state.
	useEffect(() => {
		if (!copied) {
			return;
		}
		const timer = setTimeout(() => setCopied(false), 1500);
		return () => clearTimeout(timer);
	}, [copied]);

	useEffect(() => {
		if (!keyCopied) {
			return;
		}
		const timer = setTimeout(() => setKeyCopied(false), 1500);
		return () => clearTimeout(timer);
	}, [keyCopied]);

	// Counts only while the codes are the thing on screen. Stopping at zero rather than letting the
	// interval run on is what keeps this from re-rendering the dialog once a second for as long as it
	// stays open.
	useEffect(() => {
		if (!open || stage !== "codes" || remaining === 0) {
			return;
		}
		const timer = setTimeout(() => setRemaining((seconds) => seconds - 1), 1000);
		return () => clearTimeout(timer);
	}, [open, stage, remaining]);

	if (!enrolment) {
		return null;
	}

	const confirm = (): void => {
		setError(null);
		startTransition(async () => {
			const result = await confirmTwoFactor(code);
			if (result.error) {
				setError(result.error);
				return;
			}
			setCode("");
			toast.success("Two-factor is on.");
			onOpenChange(false);
			onDone();
		});
	};

	const copyCodes = (): void => {
		void navigator.clipboard.writeText(enrolment.recoveryCodes.join("\n"));
		setCopied(true);
		toast.success("Recovery codes copied.");
	};

	let body: ReactNode = null;
	let footer: ReactNode = null;

	switch (stage) {
		case "codes":
			body = (
				<>
					<Alert variant="destructive">
						<TriangleAlert />
						<AlertTitle>Save these codes before you go on</AlertTitle>
						<AlertDescription>
							This is the only time they are shown. The panel stores them encrypted and nothing here decrypts them, so
							there is no screen that can show them to you a second time.
						</AlertDescription>
					</Alert>

					<RecoveryCodeList codes={enrolment.recoveryCodes} />

					<div className="flex items-center justify-between gap-3">
						<p className="text-sm text-muted-foreground">
							Each one signs you in once if you lose your phone. Keep them in a password manager, or on paper somewhere
							only you can reach.
						</p>
						<Button type="button" variant="outline" size="sm" className="shrink-0" onClick={copyCodes}>
							{copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
							{copied ? "Copied" : "Copy all"}
						</Button>
					</div>
				</>
			);
			footer = (
				<Button type="button" disabled={remaining > 0} onClick={() => setStage("scan")}>
					{remaining > 0 ? `I have saved these codes (${remaining})` : "I have saved these codes"}
				</Button>
			);
			break;

		case "scan":
			body = (
				<>
					{/*
					 * One centred column, and every line in it centred with the thing it describes. The step
					 * is two actions — point a phone at a square, then type what the phone says — and both are
					 * centred objects; left-aligned labels over them left every caption pointing somewhere the
					 * control was not.
					 */}
					<div className="flex flex-col items-center gap-2 text-center">
						{/*
						 * The markup comes from `totpQr` on the server, which passes a URI this server minted to
						 * bwip-js. Nothing here is user-supplied and nothing here came off the network — which is
						 * the whole reason it is not an `<img src="https://...">` to a QR service, the way a
						 * shared secret ends up in somebody else's access log.
						 *
						 * Sized rather than stretched: a QR is square and scans at any size a phone can focus
						 * on, so a full-width one is just a large white block in the middle of the dialog.
						 */}
						<div
							className="w-60 rounded-lg bg-white p-3 [&>svg]:h-auto [&>svg]:w-full"
							dangerouslySetInnerHTML={{ __html: enrolment.qrSvg }}
						/>

						{/*
						 * The key gets a code block of its own rather than sitting inline in the sentence above
						 * it. Set in running text it wrapped wherever the line ran out — mid-key, with no
						 * separator to say so — which is unreadable to type from and worse to select by hand.
						 */}
						<p className="text-sm text-muted-foreground">Cannot scan? Enter this key by hand:</p>
						<div className="flex w-full items-center gap-2 overflow-hidden rounded-lg border border-border bg-muted/40 py-1.5 pr-1.5 pl-3">
							<code className="min-w-0 flex-1 text-center font-mono text-[12px] break-all select-all">
								{secretOf(enrolment.totpUri)}
							</code>
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								className="shrink-0"
								title="Copy"
								aria-label="Copy setup key"
								onClick={() => {
									void navigator.clipboard.writeText(secretOf(enrolment.totpUri));
									setKeyCopied(true);
									toast.success("Setup key copied.");
								}}
							>
								{keyCopied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
							</Button>
						</div>
					</div>

					{/* The rule is the seam between the two halves of the step: what the phone is given, and
					    what it gives back. Without it the boxes read as a third thing about the key above them. */}
					<Separator />

					<div className="flex flex-col items-center gap-2 text-center">
						<span id="tfa-code-label" className="text-sm leading-none font-medium select-none">
							Code from the app
						</span>
						<InputOTP
							id="tfa-code"
							aria-labelledby="tfa-code-label"
							maxLength={SIX_DIGITS}
							pattern={REGEXP_ONLY_DIGITS_AND_CHARS}
							autoComplete="one-time-code"
							autoFocus
							value={code}
							disabled={pending}
							onChange={setCode}
						>
							<InputOTPGroup>
								{Array.from({ length: SIX_DIGITS }, (_unused, index) => (
									// biome-ignore lint/suspicious/noArrayIndexKey: the slot's position is its identity.
									<InputOTPSlot key={index} index={index} className="size-11 text-base" />
								))}
							</InputOTPGroup>
						</InputOTP>
						<p className="text-sm text-muted-foreground">Two-factor is not on until a code from the app is accepted.</p>
					</div>

					{error ? (
						<Alert variant="destructive">
							<AlertDescription>{error}</AlertDescription>
						</Alert>
					) : null}
				</>
			);
			footer = (
				<>
					{/*
					 * The way back to the codes stays open until the enrolment is confirmed — an operator who
					 * pressed on and then reached for a password manager should not have to abandon the
					 * enrolment to see them again.
					 */}
					<Button type="button" variant="ghost" disabled={pending} onClick={() => setStage("codes")}>
						Show the codes again
					</Button>
					<Button type="button" disabled={pending || code.length < SIX_DIGITS} onClick={confirm}>
						{pending ? <Spinner className="size-3.5" /> : null}
						Turn two-factor on
					</Button>
				</>
			);
			break;
	}

	return (
		// `disablePointerDismissal` because either stage holds something a stray click outside would
		// destroy: an enrolment that is not confirmed yet, and recovery codes that are shown once.
		<Dialog open={open} onOpenChange={onOpenChange} disablePointerDismissal>
			<DialogContent className="sm:max-w-[520px]">
				<DialogHeader>
					<DialogTitle>Set up two-factor</DialogTitle>
					<DialogDescription>
						{stage === "codes" ? "Step 1 of 2 — your recovery codes." : "Step 2 of 2 — scan the code and confirm."}
					</DialogDescription>
				</DialogHeader>
				<DialogBody>{body}</DialogBody>
				<DialogFooter>{footer}</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/**
 * The ten codes, laid out to be read off the screen and typed or copied.
 *
 * Boxed and numbered rather than set as a bare list: the box is what makes them look like something
 * handed over rather than a paragraph of the surrounding prose, and the numbers make it obvious at a
 * glance that none was missed when they were copied by hand.
 */
function RecoveryCodeList({ codes }: { codes: string[] }) {
	return (
		// `grid-flow-col` with five rows, so the numbers run 1–5 down the left and 6–10 down the right.
		// Row-major put 1 and 2 side by side, which is not how anyone reads a numbered list off a page
		// while ticking them into a password manager.
		<ol className="grid grid-flow-col grid-rows-5 gap-x-6 gap-y-1.5 rounded-lg border border-border bg-muted/40 px-4 py-3 font-mono text-sm tabular-nums select-all">
			{codes.map((recoveryCode, index) => (
				<li key={recoveryCode} className="flex gap-2">
					<span className="w-4 shrink-0 text-right text-muted-foreground select-none">{index + 1}</span>
					<span>{recoveryCode}</span>
				</li>
			))}
		</ol>
	);
}

/** The shared secret out of an `otpauth:` URI, for an operator whose phone cannot scan. */
function secretOf(uri: string): string {
	try {
		return new URL(uri).searchParams.get("secret") ?? "";
	} catch {
		return "";
	}
}
