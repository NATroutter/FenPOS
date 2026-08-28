import { apiRoute } from "@/lib/api/api-route";
import { PRINT_REQUEST_MAX_BODY_BYTES, readBoundedJson } from "@/lib/api/bounded-body";
import { requireApiRead } from "@/lib/auth/rate-limit";
import { compilePreview } from "@/lib/jobs/preview";
import { requireGrantedDevice } from "@/lib/keys/authenticate";

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

export const POST = apiRoute<{ agent: string; device: string }>(
	"api:POST /v1/preview/{agent}/{device}",
	async ({ key, request, params }) => {
		const { agent, device } = params;

		await requireApiRead(key.id);

		const target = await requireGrantedDevice(key, agent, device);

		const { body } = await readBoundedJson(request, PRINT_REQUEST_MAX_BODY_BYTES);

		// The key's own name goes with it. A receipt using an `API_KEY_NAME` variable is compiled
		// against the same name a print by this key would substitute, which is the only way the claim
		// this endpoint makes — that what comes back is what the printer would produce — stays true for
		// such a receipt. It is not merely the substituted text that would otherwise differ: a name of
		// a different length wraps differently and changes the `outputLines` the response reports.
		const preview = await compilePreview(target.id, body, key.name);

		return {
			response: Response.json({ agent, device, ...preview }),
			// A receipt that did not compile is still a 200 — see this module's own note — so the line
			// has to say which of the two happened, or the Logs tab would report every preview as the
			// same event.
			message:
				preview.errors.length === 0
					? `Previewed ${preview.outputLines} lines for '${target.name}'`
					: `Previewed markup for '${target.name}' that would not compile: ${preview.errors.length} faults`,
			target: { agentId: target.agentId, agentName: agent, deviceId: target.id, deviceName: target.name },
		};
	},
);
