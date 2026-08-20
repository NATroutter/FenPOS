"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/app/(panel)/agents/action-state";
import { createAsset, deleteAsset, importAssetFromUrl, requireWithinByteCap } from "@/lib/assets/asset-service";
import { requireSession } from "@/lib/auth/require-session";
import { ApiError } from "@/lib/errors";
import { pushConfigToEveryAgent } from "@/lib/link/agent-connection";
import { logger } from "@/lib/logger";

/**
 * Server actions behind the Assets tab.
 *
 * Every action re-checks the session. The panel layout already guards the page, but an action is a
 * POST endpoint in its own right: anything that trusted the layout would be callable directly by
 * anyone who knew the action id. That matters more here than elsewhere, because these two actions
 * are the only ones in the panel that accept a file and the only ones that make this server fetch a
 * URL somebody else chose.
 */

/**
 * Runs an action, converting a failure into a message the panel can render.
 *
 * @param label short description used in the log line
 * @param work the action body
 * @returns the state to render
 */
async function run(label: string, work: () => Promise<void>): Promise<ActionState> {
	// Outside the try: an absent session redirects, and `redirect` signals by throwing. Catching
	// it here would turn being signed out into a toast over a panel that no longer works.
	await requireSession();

	try {
		await work();
		// Every action here changes the image library, and every connected agent holds a copy of it
		// dithered for its own paper. Pushed now rather than left to the next reconnect, so a logo
		// uploaded during service is on the printers before the next receipt asks for it.
		await pushConfigToEveryAgent();
		revalidatePath("/assets");
		return { error: null };
	} catch (error) {
		if (error instanceof ApiError) {
			return { error: error.message };
		}
		logger.error(`Asset action failed: ${label}`, error);
		return { error: "Something went wrong. Check the server log." };
	}
}

/**
 * Stores an uploaded image.
 *
 * The size is checked here, from what the browser declared, before the file is pulled into memory —
 * and checked again inside `createAsset` against the bytes that actually arrived, because a declared
 * size is a claim. `next.config.ts` sets the framework's own body limit deliberately higher than
 * this, so that the limit this product enforces is the one written in code rather than one inherited
 * from a default nobody would find.
 *
 * @param formData a `name` and a `file`
 * @returns the state to render
 */
export async function uploadAsset(formData: FormData): Promise<ActionState> {
	return run("upload", async () => {
		const file = formData.get("file");
		if (!(file instanceof File) || file.size === 0) {
			throw new ApiError("missing_field", "Choose an image to upload.");
		}
		requireWithinByteCap(file.size);

		const name = formData.get("name");
		await createAsset(typeof name === "string" ? name : "", Buffer.from(await file.arrayBuffer()));
	});
}

/**
 * Fetches an image by URL and stores it.
 *
 * @param name what markup will refer to it by
 * @param url where to fetch it from
 * @returns the state to render
 */
export async function importAsset(name: string, url: string): Promise<ActionState> {
	return run("import", async () => {
		await importAssetFromUrl(name, url);
	});
}

/**
 * Deletes an image.
 *
 * @param id the asset to delete
 * @returns the state to render
 */
export async function removeAsset(id: string): Promise<ActionState> {
	return run("delete", () => deleteAsset(id));
}
