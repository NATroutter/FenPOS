import { z } from "zod";
import { readBoundedJson } from "@/lib/api/bounded-body";
import { prisma } from "@/lib/db";
import { MAX_NAME_LENGTH } from "@/lib/domain/naming";
import { ApiError, toErrorResponse } from "@/lib/errors";
import {
	type AuthenticatedKey,
	authenticateKey,
	requireGrantedDevice,
	requirePermission,
} from "@/lib/keys/authenticate";
import { sendRawWrite } from "@/lib/link/commands";
import { logger } from "@/lib/logger";
import { recordServerLog } from "@/lib/logs/log-service";
import { booleanSetting, integerSetting } from "@/lib/settings/settings-service";

/**
 * `POST /api/v1/devices/{agent}/{device}/raw` — arbitrary ESC/POS bytes, straight to a printer.
 *
 * **This endpoint bypasses everything.** No wrapping, no codepage validation, no line or character
 * limits, no width calculation — the bytes reach the hardware exactly as sent. That is the entire
 * point of it, and the reason it is gated twice: a key must hold `devices:raw`, *and* the install
 * must have `link.allowRawApiWrites` switched on, which it is not by default. Granting the
 * permission on an install that has not enabled the setting grants nothing.
 *
 * **The order of the checks is load-bearing.** The install setting is tested before the device
 * grant, so an install with raw writes off answers every caller identically and cannot be used to
 * discover which printers exist. Reordering these for tidiness reopens exactly the enumeration hole
 * `requireGrantedDevice` exists to close.
 *
 * **Nothing here can say what was printed.** The server never reads the bytes, and the printer does
 * not report back what it did with them. The audit row is therefore the only record that a write
 * happened at all, which is why it is written for refusals as well as for successes, and why it goes
 * to the Logs tab rather than to stdout.
 *
 * `sendRawWrite`'s timeout message — "the bytes may or may not have been written" — is passed
 * through unchanged. It is the honest answer, and the operator is the only one who can go and look
 * at the paper.
 */

/** The request body: base64 bytes, and nothing else. */
const rawWriteSchema = z.object({
	bytes: z.string().min(1),
});

export async function POST(
	request: Request,
	context: { params: Promise<{ agent: string; device: string }> },
): Promise<Response> {
	const { agent, device } = await context.params;
	let key: AuthenticatedKey | null = null;
	let target: Awaited<ReturnType<typeof requireGrantedDevice>> | null = null;

	// How many bytes were handed to `sendRawWrite`, or null while nothing has been. This is what
	// separates a refusal from a failure of unknown outcome in the audit trail below: everything
	// before the send is a refusal — nothing was written, and the row may say so — while a failure
	// once this is set has to leave the question open, because the timeout case genuinely is open.
	//
	// Set before the call, not after, which deliberately conflates two of the three outcomes: see
	// {@link auditFailure}.
	let handedOff: number | null = null;

	try {
		key = await authenticateKey(request);
		requirePermission(key, "devices:raw");

		// Before the device grant, deliberately — see the module comment. An install with this off
		// gives one answer to everybody, and the answer names nothing about this install.
		if (!(await booleanSetting("link.allowRawApiWrites"))) {
			throw new ApiError(
				"raw_writes_disabled",
				"Raw writes are switched off for this install. An administrator can enable them under Settings → Security.",
			);
		}

		target = await requireGrantedDevice(key, agent, device);

		const cap = await integerSetting("link.maxRawWriteBytes");
		const bytes = await readBytes(request, cap);

		// Recorded before the write, not after. A write that reaches the printer and then fails on the
		// way back must still leave a trace — the paper has moved either way, and an audit trail that
		// only records the writes that returned cleanly is not an audit trail.
		//
		// `target.name` rather than the path segment: this line is written after the grant check, so
		// the stored name is available and is the one an operator recognises. `agent` is the path
		// segment too, but the grant check having succeeded means it is not merely untrusted input
		// here: `requireGrantedDevice` matched it against the device's actual agent by exact name, so
		// it is the verified name, not the caller's claim of it — the same reasoning `target.name`
		// already relies on for the device.
		await recordServerLog("INFO", `Raw write of ${bytes.length} bytes to '${target.name}' by key '${key.name}'.`, {
			agentId: target.agentId,
			agentName: agent,
			deviceId: target.id,
			deviceName: target.name,
		});

		handedOff = bytes.length;
		const message = await sendRawWrite(target.agentId, target.name, bytes.toString("base64"));

		logger.info("Raw write accepted", {
			keyId: key.id,
			agentName: agent,
			deviceName: device,
			bytes: bytes.length,
		});

		return Response.json({ agent, device, bytes: bytes.length, message: message ?? null });
	} catch (error) {
		// An identified caller leaves a trace whatever went wrong; an unidentified one does not,
		// because there is nothing to attribute it to and a row per unauthenticated request is a way
		// to fill a disk. `authenticateKey`'s own failures are the only ones that reach here with a
		// null key. An unexpected fault is recorded too, under the code the caller was given for it:
		// "every write and every refusal is recorded" cannot hold only for the failures this route
		// anticipated, since an operator has no other way to learn that one happened.
		if (key) {
			const code = error instanceof ApiError ? error.code : "internal_error";

			// Named even on the refusals that never got as far as resolving a device, so every line
			// this route writes reaches the Logs tab's agent filter and its live stream — which is
			// what `recordServerLog` means by "the raw-write caller always names an agent". The
			// lookup is skipped once the grant check has already produced the id.
			const agentId = target?.agentId ?? (await agentIdNamed(agent));

			await recordServerLog("WARN", auditFailure(device, key.name, code, handedOff, error), {
				agentId,
				// Only once an id is known: `agentId` above is only ever set by an exact match against a
				// real agent's name (the grant check, or `agentIdNamed`'s own lookup), so `agent` is the
				// verified name in that case. When nothing matched, there is no agent to name — storing
				// the caller's unverified path segment as if it were one would misattribute the line to
				// an agent that may not exist, which is worse than leaving it unattributed.
				agentName: agentId ? agent : undefined,
				deviceId: target?.id,
				deviceName: target?.name,
			});
		}

		return toErrorResponse(error, { route: "POST /api/v1/devices/[agent]/[device]/raw", agent, device });
	}
}

/**
 * The audit line for a request that did not return a write.
 *
 * **Two wordings for three facts, and the conflation is deliberate.** Everything up to the send is a
 * refusal: nothing left this server, and the line says so. Once the bytes have been handed to
 * `sendRawWrite`, "refused" would be a lie in the one direction that matters — the timeout case
 * cannot say whether the printer wrote them, which is why that function's own message ends "the
 * bytes may or may not have been written". A trail that recorded that as a refusal would tell an
 * operator the paper is clean when it may not be, and the paper is the only place they can check.
 *
 * The third fact is that two failures *inside* `sendRawWrite` also provably sent nothing — the agent
 * was not connected, and the socket dropped before the frame went out (`lib/link/commands.ts`) — and
 * this function reports both under the second wording, because `handedOff` is set before the call
 * rather than after it. That is the safe direction of the two: an audit line that says "may have
 * been written" about a write that certainly was not sends an operator to look at a printer for
 * nothing, while the reverse tells them not to look at one that may have moved paper. Separating
 * them would mean `sendRawWrite` reporting *where* it failed, not just that it did, and the honest
 * detail below already carries the agent's own sentence — "That agent is not connected" reads
 * differently from "did not answer" to the person reading the row.
 *
 * The underlying message is carried through on that second path rather than summarised, because it
 * is the sentence that distinguishes "never connected" from "did not answer" — the difference
 * between a write that certainly did not happen and one nobody can account for.
 *
 * The device is named from the path segment and bounded to {@link MAX_NAME_LENGTH}, since a
 * refusal before the grant check has no stored row to name it from. `nameSchema` bounds every real
 * device to that length, so truncating cannot shorten a name that exists here, while an invented
 * segment cannot write an unbounded string into a row `recordServerLog` stores verbatim — its
 * contract asks callers to truncate anything that could be long, and this is the one field on this
 * path a caller chooses.
 *
 * **The outcome comes first, the names last.** `recordServerLog` truncates from the end at
 * `logs.maxMessageChars`, whose configurable floor is 200 — and a 64-character device name plus a
 * 64-character key name, the most `MAX_NAME_LENGTH` allows on each, already consume most of that
 * budget. If the sentence that actually answers "was anything sent" sat after them, that setting's
 * minimum would cut it away and leave only the preamble, which is the one trade the audit trail
 * cannot afford — the whole reason this row exists is that it is the only record a write happened.
 * So the code and, on the second wording, the honest detail come immediately after the fixed lead-in,
 * comfortably inside 200 characters on their own; the byte count and the two names are parenthesised
 * afterward and are what gives way if the line is still too long.
 *
 * @param device the device named in the path, untrusted and possibly naming nothing
 * @param keyName the authenticated key's name, for attribution
 * @param code the error code the caller was answered with
 * @param handedOff how many bytes had been handed to the agent, or null if none had
 * @param error what went wrong
 * @returns the line to record
 */
function auditFailure(device: string, keyName: string, code: string, handedOff: number | null, error: unknown): string {
	const named = device.slice(0, MAX_NAME_LENGTH);

	if (handedOff === null) {
		return `Raw write refused: ${code}. Nothing was sent. (device '${named}', key '${keyName}')`;
	}

	const detail = error instanceof ApiError ? ` ${error.message}` : "";
	return `Raw write did not complete: ${code}.${detail} (${handedOff} bytes, device '${named}', key '${keyName}')`;
}

/**
 * The id of the agent a refused request named, when it named a real one.
 *
 * Only the audit line reads this, and only on a path that has not resolved a device: a refusal
 * before the grant check — raw writes switched off, most of all — still has to be attributable to
 * somewhere, and the path's own agent name is all such a request has said about itself. A name
 * matching no agent leaves the line unattributed rather than inventing an attribution, which is
 * what the nullable column on `LogEntry` is for.
 *
 * Reading this changes no response: it runs after the refusal has been decided, so it cannot make
 * a disabled install answer two callers differently.
 *
 * @param agentName the agent named in the path
 * @returns its id, or undefined when no agent goes by that name
 */
async function agentIdNamed(agentName: string): Promise<string | undefined> {
	const row = await prisma.agent.findUnique({ where: { name: agentName }, select: { id: true } });
	return row?.id;
}

/**
 * How large a raw-write body may be before it is parsed.
 *
 * The cap the operator configured is on the *bytes that reach the printer*, and the body carries
 * them base64-encoded inside JSON, so the ceiling this route reads up to has to cover both
 * inflations — the same shape `maxCreateAssetBodyBytes` uses in the assets route, and for the same
 * reason. Base64 turns 3 bytes into 4 characters, a 4/3 expansion; the envelope adds
 * `{"bytes":"…"}` — one field name, its quoting, the object's punctuation, and up to two characters
 * of base64 padding. 256 bytes of headroom past the expansion covers that with room for an
 * integrator's whitespace.
 *
 * Deliberately generous rather than exact. The real limit is enforced on the decoded bytes in
 * {@link readBytes}; this exists only so a body far too large to be a legitimate raw write is
 * refused before `JSON.parse` and a base64 decode do the work of reading it.
 *
 * @param cap the configured `link.maxRawWriteBytes`
 * @returns the byte ceiling this route reads a body up to
 */
function maxRawWriteBodyBytes(cap: number): number {
	return Math.ceil((cap * 4) / 3) + 256;
}

/**
 * Reads the payload from the request body.
 *
 * Base64 is validated by re-encoding rather than by a regular expression: `Buffer.from` accepts
 * anything and silently discards what it cannot read, so a body of punctuation would otherwise
 * decode to an empty buffer and be sent to a printer as a successful write of nothing.
 *
 * The configured cap is checked on the decoded length, not on the body's, because that is what the
 * setting promises an operator: the most bytes one write may put through a printer. A body that
 * passes {@link maxRawWriteBodyBytes} can still decode to more than the cap allows.
 *
 * This is the last size check, and there is deliberately no third one against what a link frame can
 * carry. `link.maxRawWriteBytes` derives its own maximum from the `raw.write` frame's payload bound
 * (`rawWriteByteCeiling` in `lib/settings/settings-service.ts`), and a stored value outside a
 * setting's bounds is ignored in favour of the fallback rather than clamped — so `cap` can never
 * exceed what `serialiseServerFrame` will accept, and a check here could only ever be dead code
 * restating the number the derivation exists to stop anyone restating.
 *
 * @param request the incoming request
 * @param cap the configured `link.maxRawWriteBytes`
 * @returns the decoded bytes
 * @throws ApiError when the body is too large, is not JSON, names no bytes, is not valid base64, or
 *   decodes to more than the cap allows
 */
async function readBytes(request: Request, cap: number): Promise<Buffer> {
	const { body } = await readBoundedJson(request, maxRawWriteBodyBytes(cap));

	const parsed = rawWriteSchema.safeParse(body);
	if (!parsed.success) {
		throw new ApiError("missing_field", "Body must carry 'bytes' as a base64 string.");
	}

	const decoded = Buffer.from(parsed.data.bytes, "base64");
	if (decoded.toString("base64") !== parsed.data.bytes.replace(/\s/g, "")) {
		throw new ApiError("invalid_type", "'bytes' is not valid base64.");
	}

	if (decoded.length > cap) {
		throw new ApiError("body_too_large", `A raw write may carry at most ${cap} bytes; this one is ${decoded.length}.`, {
			bytes: decoded.length,
			limit: cap,
		});
	}

	return decoded;
}
