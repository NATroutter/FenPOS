"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import type { ActionState } from "@/app/(panel)/agents/action-state";
import {
	createAsset,
	deleteAsset,
	importAssetFromUrl,
	// Aliased so the actions below can carry the plain names the client imports. The service's own
	// names say what they do to storage; an action's say what the operator pressed.
	renameAsset as renameStoredAsset,
	replaceAsset as replaceStoredAsset,
	replaceAssetFromUrl as replaceStoredAssetFromUrl,
	requireWithinByteCap,
} from "@/lib/assets/asset-service";
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
		revalidatePath("/assets");
	} catch (error) {
		if (error instanceof ApiError) {
			return { error: error.message };
		}
		// The message and the stack, never the error object. `importAsset` is where an operator types
		// a URL, and a URL is exactly where credentials get embedded. `safeUrl` strips them from
		// everything that reaches an `ApiError`, but a failure inside `fetchRemoteImage` arrives as an
		// undici error whose `cause` chain can still be carrying the address as it was written — and
		// `logger.error`'s second argument serialises that whole chain into a line the panel displays.
		// Three rounds of fixes went into keeping credentials out of these logs; this is the door they
		// were still open at.
		//
		// The name, the message and the stack are all kept, so what is actually given up is the cause
		// chain — which is the part that carries the untrusted URL and the part least often needed to
		// find a fault. A genuine failure still logs its type, its wording and where it was raised.
		logger.error(`Asset action failed: ${label}`, undefined, {
			failure: error instanceof Error ? error.name : typeof error,
			reason: error instanceof Error ? error.message : "unknown failure",
			stack: error instanceof Error ? error.stack : undefined,
		});
		return { error: "Something went wrong. Check the server log." };
	}

	// Every action here changes the image library, and every connected agent holds a copy of it
	// dithered for its own paper — so each one has to be sent a fresh configuration, rather than the
	// change waiting for whenever that agent next reconnects.
	//
	// **Scheduled rather than awaited, and deliberately outside the try.** Fanning out is work that
	// scales with how many agents are connected and how many images are stored, and none of it is
	// work the operator who pressed Upload is waiting for: their file is already saved. Leaving it on
	// the response path made an upload's latency somebody else's printer count. Being outside the
	// try is the other half: a sync that failed must not report "something went wrong" for an upload
	// that plainly succeeded, and that must be true by construction rather than because
	// `pushDeviceConfig` happens to swallow its own errors today.
	after(pushConfigToEveryAgent);

	return { error: null };
}

/**
 * Stores an uploaded image.
 *
 * The size is checked here, from what the browser declared, before this action reads the file's
 * bytes into a second, its own copy — Next has already buffered the whole request body to build
 * this `FormData` by the time any server action code runs, so this check saves only that second
 * `arrayBuffer()` copy, not the first. It is checked again inside `createAsset` against the bytes
 * that actually arrived, because a declared size is a claim. `next.config.ts` sets the framework's
 * own body limit deliberately higher than this, so that the limit this product enforces is the one
 * written in code rather than one inherited from a default nobody would find.
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
		await requireWithinByteCap(file.size);

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
 * Renames an image.
 *
 * Every receipt that names the old one is refused from here on, which is the operator's decision to
 * make and is why the panel asks for it in a dialog that says so. Like the two above, this goes
 * through `run`, so the agents are re-pushed: each holds its copy of the library keyed by name, and
 * one that was not told would go on offering the old name and refusing the new one.
 *
 * @param id the asset to rename
 * @param name the new name
 * @returns the state to render
 */
export async function renameAsset(id: string, name: string): Promise<ActionState> {
	return run("rename", async () => {
		await renameStoredAsset(id, name);
	});
}

/**
 * Replaces an image's bytes with an uploaded file, keeping its name.
 *
 * The size is checked from the browser's declared figure before this reads the bytes, for exactly
 * the reason {@link uploadAsset} gives — and it is checked again inside the service against what
 * actually arrived.
 *
 * @param formData an `id` and a `file`
 * @returns the state to render
 */
export async function replaceAsset(formData: FormData): Promise<ActionState> {
	return run("replace", async () => {
		const file = formData.get("file");
		if (!(file instanceof File) || file.size === 0) {
			throw new ApiError("missing_field", "Choose an image to upload.");
		}
		await requireWithinByteCap(file.size);

		const id = formData.get("id");
		await replaceStoredAsset(typeof id === "string" ? id : "", Buffer.from(await file.arrayBuffer()));
	});
}

/**
 * Replaces an image's bytes with one fetched from a URL, keeping its name.
 *
 * @param id the asset to replace
 * @param url where to fetch the new image from
 * @returns the state to render
 */
export async function replaceAssetFromUrl(id: string, url: string): Promise<ActionState> {
	return run("replace from url", async () => {
		await replaceStoredAssetFromUrl(id, url);
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
