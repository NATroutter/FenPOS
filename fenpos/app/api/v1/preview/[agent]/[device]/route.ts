import { requireApiRead } from "@/lib/auth/rate-limit";
import { ApiError, toErrorResponse } from "@/lib/errors";
import { compilePreview } from "@/lib/jobs/preview";
import { authenticateKey, requireGrantedDevice, requirePermission } from "@/lib/keys/authenticate";

/**
 * `POST /api/v1/preview/{agent}/{device}` — what this body would print, without printing it.
 *
 * Behind `print` rather than a permission of its own. Preview is strictly less powerful than
 * printing and reveals nothing a key holding `print` could not learn by printing; a separate
 * permission would be a checkbox that grants no new authority and one more thing to get wrong.
 *
 * **Markup that does not compile is a 200 carrying the fault.** The request succeeded — the caller
 * asked what this would print and received a complete, accurate answer, which happens to be "it
 * would not". Reserving non-2xx for the credential, the grant and the envelope is what lets a client
 * distinguish a mistake in a receipt from a mistake in a request without parsing either.
 *
 * Works while the agent is offline, unlike printing: nothing here needs the machine holding the
 * printer, only its configuration, which this server owns.
 */

/** Largest body accepted, matching the print endpoint so a body that previews can always be sent. */
const MAX_BODY_BYTES = 64 * 1024;

export async function POST(
	request: Request,
	context: { params: Promise<{ agent: string; device: string }> },
): Promise<Response> {
	const { agent, device } = await context.params;

	try {
		const key = await authenticateKey(request);
		requirePermission(key, "print");

		await requireApiRead(key.id);

		const target = await requireGrantedDevice(key, agent, device);

		const raw = await request.text();
		if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
			throw new ApiError("body_too_large", `Request body must be under ${MAX_BODY_BYTES} bytes.`);
		}

		let body: unknown;
		try {
			body = JSON.parse(raw);
		} catch {
			throw new ApiError("invalid_json", "Body is not valid JSON");
		}

		return Response.json({ agent, device, ...(await compilePreview(target.id, body)) });
	} catch (error) {
		return toErrorResponse(error, { route: "POST /api/v1/preview/[agent]/[device]", agent, device });
	}
}
