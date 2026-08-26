import "server-only";
import { headers } from "next/headers";
import { auth } from "@/lib/auth/auth";
import { totpQr } from "@/lib/auth/totp-qr";
import { ApiError } from "@/lib/errors";

/**
 * Enrolling, confirming and removing the caller's own second factor.
 *
 * A thin layer over the plugin rather than a reimplementation, for the reason the panel uses Better
 * Auth at all: TOTP is a specification with a shared clock, a base32 secret and a drift window, and
 * a hand-rolled one is a thing that appears to work against the phone it was written with.
 *
 * What this module adds is the *shape* of the flow. `enableTwoFactor` returns a union — the plugin
 * can also enrol by emailed OTP — and this install has no mail, so the branch that would hand back
 * a code nobody receives is turned into a refusal here rather than left for a caller to forget.
 * It also puts the QR beside the URI, because every caller wants both and neither wants bwip-js.
 */

/** What an authenticator app labels the entry with. Matches the `issuer` given to the plugin. */
export const TOTP_ISSUER = "FenPOS";

/** Everything the enrolment screen needs, handed over once. */
export interface Enrolment {
	/** The `otpauth:` URI, for an operator who cannot scan and must type the secret in. */
	totpUri: string;
	/** The same URI as inline SVG. */
	qrSvg: string;
	/**
	 * One-time codes that stand in for the authenticator.
	 *
	 * Returned once and never again: the plugin stores them encrypted at rest (`auth.ts` pins
	 * `storeBackupCodes: "encrypted"`), and there is no panel path that decrypts and re-displays
	 * them. An operator who does not write them down and then loses their phone needs an
	 * administrator to clear the enrolment.
	 */
	recoveryCodes: string[];
}

/**
 * Starts enrolment: stores a secret, and hands back what the operator needs to accept it.
 *
 * **The account is not enrolled when this returns.** `skipVerificationOnEnable` is left at the
 * plugin's default of false, so `twoFactorEnabled` stays off until {@link confirmEnrolment}
 * verifies a code the authenticator produced. An operator who scans the QR, is interrupted and
 * closes the dialog is left with the account they started with rather than locked out by a secret
 * their phone never finished accepting.
 *
 * **Refused outright when the account already has a verified enrolment.** The plugin does not
 * treat a second `enableTwoFactor` as a no-op: it replaces the existing secret and recovery codes
 * in place, `verified: true`, live, with no confirmation step. A stale tab still showing the
 * "set up" screen could otherwise mint a fresh secret that takes effect at once and silently
 * strands the operator's already-working authenticator. Turning the existing one off first, via
 * {@link endEnrolment}, is the only path back in.
 *
 * The password is required even though the caller holds a session, for the reason
 * `changePassword` asks for it: a session left open on an unattended machine is the case this
 * defends against, and adding a second factor from one would lock the real owner out.
 *
 * @param password the caller's current password
 * @returns the URI, its QR, and the recovery codes
 * @throws ApiError when the account is already enrolled, the password is wrong, or the plugin
 *   enrols by a method this install cannot use
 */
export async function beginEnrolment(password: string): Promise<Enrolment> {
	const session = await auth.api.getSession({ headers: await headers() });
	// Read through `Boolean` rather than trusted as typed, matching `currentUser`: the column is a
	// SQLite integer, and a null from a row written before it existed must read as "no", never as
	// "unknown" and certainly never as "yes".
	const alreadyEnrolled = Boolean(session?.user.twoFactorEnabled);
	if (alreadyEnrolled) {
		throw new ApiError("already_enrolled", "Two-factor is already on. Turn it off before setting up a new one.");
	}

	let result: Awaited<ReturnType<typeof auth.api.enableTwoFactor>>;
	try {
		result = await auth.api.enableTwoFactor({
			body: { password, method: "totp", issuer: TOTP_ISSUER },
			headers: await headers(),
		});
	} catch {
		// The plugin collapses its refusals into one error and, from the caller's side, only one of
		// them matters: the password they typed is not the account's.
		throw new ApiError("invalid_key", "That is not your current password.");
	}

	if (result.method !== "totp") {
		// Unreachable while `method: "totp"` is passed above, and checked anyway: the union exists
		// because the plugin can enrol by emailed OTP, this install sends no mail, and a silent fall
		// through would hand an operator a screen with no QR and no explanation.
		throw new ApiError("invalid_type", "This install can only enrol an authenticator app.");
	}

	let qrSvg: string;
	try {
		qrSvg = totpQr(result.totpURI);
	} catch {
		// Kept inside its own try, throwing a fixed message rather than letting bwip-js's own message
		// through: `result.totpURI` carries the secret this call just minted, and an error here is
		// the one failure in this module that would otherwise put that URI's text into whatever
		// catches it — including `panelQuery`'s failure handler, which writes `error.message` into an
		// append-only audit row.
		throw new ApiError("internal_error", "Could not prepare the QR code for this enrolment.");
	}

	return { totpUri: result.totpURI, qrSvg, recoveryCodes: result.backupCodes };
}

/**
 * Accepts a code from the authenticator, which is what actually turns the second factor on.
 *
 * @param code the six digits currently shown by the app
 * @throws ApiError when the code does not match the stored secret
 */
export async function confirmEnrolment(code: string): Promise<void> {
	try {
		await auth.api.verifyTOTP({ body: { code }, headers: await headers() });
	} catch {
		throw new ApiError("invalid_key", "That code is not right. Check your authenticator and try again.");
	}
}

/**
 * Removes the caller's own second factor.
 *
 * The password again, and for a stronger reason than enrolment: this is the one action here that
 * *weakens* the account, and an unattended session that could turn a second factor off would make
 * having one pointless.
 *
 * The plugin deletes its own rows and clears the flag together. `account-security.clearTwoFactor`
 * exists for the administrator's path — clearing somebody *else's* enrolment, where there is no
 * password to ask for — and the two must not be confused: this one goes through the plugin so the
 * password is checked.
 *
 * @param password the caller's current password
 * @throws ApiError when the password is wrong
 */
export async function endEnrolment(password: string): Promise<void> {
	try {
		await auth.api.disableTwoFactor({ body: { password }, headers: await headers() });
	} catch {
		throw new ApiError("invalid_key", "That is not your current password.");
	}
}
