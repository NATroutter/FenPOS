import { z } from "zod";
import { readBoundedJson } from "@/lib/api/bounded-body";
import { prisma } from "@/lib/db";
import { ApiError, toErrorResponse } from "@/lib/errors";
import {
	type AuthenticatedKey,
	authenticateKey,
	type GrantedDevice,
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
	let target: Pick<GrantedDevice, "id" | "name" | "agentId"> | null = null;

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
		await recordServerLog("INFO", `Raw write of ${bytes.length} bytes to '${device}' by key '${key.name}'.`, {
			agentId: target.agentId,
			deviceId: target.id,
		});

		const message = await sendRawWrite(target.agentId, target.name, bytes.toString("base64"));

		logger.info("Raw write accepted", {
			keyId: key.id,
			agentName: agent,
			deviceName: device,
			bytes: bytes.length,
		});

		return Response.json({ agent, device, bytes: bytes.length, message: message ?? null });
	} catch (error) {
		// An identified caller who was refused leaves a trace; an unidentified one does not, because
		// there is nothing to attribute it to and a row per unauthenticated request is a way to fill a
		// disk. `authenticateKey`'s own failures are the only ones that reach here with a null key.
		if (key && error instanceof ApiError) {
			await recordServerLog("WARN", `Raw write to '${device}' refused for key '${key.name}': ${error.code}.`, {
				// Named even on the refusals that never got as far as resolving a device, so every line
				// this route writes reaches the Logs tab's agent filter and its live stream — which is
				// what `recordServerLog` means by "the raw-write caller always names an agent". The
				// lookup is skipped once the grant check has already produced the id.
				agentId: target?.agentId ?? (await agentIdNamed(agent)),
				deviceId: target?.id,
			});
		}

		return toErrorResponse(error, { route: "POST /api/v1/devices/[agent]/[device]/raw", agent, device });
	}
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
