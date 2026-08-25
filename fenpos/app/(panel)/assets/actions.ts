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
import { type PanelActionOptions, panelAction } from "@/lib/auth/panel-action";
import type { PanelActionId } from "@/lib/auth/panel-actions";
import { ApiError } from "@/lib/errors";
import { pushConfigToEveryAgent } from "@/lib/link/agent-connection";
import { logger } from "@/lib/logger";

/**
 * Server actions behind the Assets tab.
 *
 * Every action goes through the shared gate, which resolves the session, checks the permission its
 * registry entry names, runs the body, and records the attempt. That matters more here than
 * elsewhere, because these are the only actions in the panel that accept a file and the only ones
 * that make this server fetch a URL somebody else chose.
 */

/**
 * Runs an asset action through the gate, keeping the two things this tab does that others do not.
 *
 * **An unexpected failure is logged here and never allowed to travel.** `importAsset` is where an
 * operator types a URL, and a URL is exactly where credentials get embedded. `safeUrl` strips them
 * from everything that reaches an `ApiError`, but a failure inside `fetchRemoteImage` arrives as an
 * undici error whose message and `cause` chain can still be carrying the address as it was written.
 * Three rounds of fixes went into keeping credentials out of the logs; the audit record is a fourth
 * door, and one with no delete path behind it. So the original error is logged as name, message and
 * stack — never the object, so the cause chain is dropped — and what is rethrown for the gate to
 * record is a bare sentence carrying nothing an operator typed.
 *
 * **The agent fan-out runs only after a success, and is scheduled rather than awaited.** Every
 * action here changes the image library, and every connected agent holds a copy of it dithered for
 * its own paper, so each has to be sent a fresh configuration rather than waiting for its next
 * reconnect. That work scales with how many agents are connected and how many images are stored,
 * and none of it is work the operator who pressed Upload is waiting for: their file is already
 * saved.
 *
 * @param id the action's registry id
 * @param work the action body
 * @param options what to name in the record
 * @returns the state to render
 */
async function assetAction(
	id: PanelActionId,
	work: () => Promise<void>,
	options: Omit<PanelActionOptions, "revalidate"> = {},
): Promise<ActionState> {
	const state = await panelAction(
		id,
		async () => {
			try {
				await work();
			} catch (error) {
				if (error instanceof ApiError) {
					throw error;
				}
				logger.error(`Asset action failed: ${id}`, undefined, {
					failure: error instanceof Error ? error.name : typeof error,
					reason: error instanceof Error ? error.message : "unknown failure",
					stack: error instanceof Error ? error.stack : undefined,
				});
				throw new Error("The asset operation failed. See the server log.");
			}
		},
		{ ...options, revalidate: () => revalidatePath("/assets") },
	);

	if (state.error === null) {
		after(pushConfigToEveryAgent);
	}

	return state;
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
	const name = formData.get("name");
	return assetAction(
		"assets:upload",
		async () => {
			const file = formData.get("file");
			if (!(file instanceof File) || file.size === 0) {
				throw new ApiError("missing_field", "Choose an image to upload.");
			}
			await requireWithinByteCap(file.size);

			await createAsset(typeof name === "string" ? name : "", Buffer.from(await file.arrayBuffer()));
		},
		// The name and nothing else. The bytes are already in the asset table, and a base64 slice of
		// an image in an append-only record is neither readable nor worth keeping.
		{ target: { kind: "asset", label: typeof name === "string" ? name : null } },
	);
}

/**
 * Fetches an image by URL and stores it.
 *
 * @param name what markup will refer to it by
 * @param url where to fetch it from
 * @returns the state to render
 */
export async function importAsset(name: string, url: string): Promise<ActionState> {
	return assetAction(
		"assets:import",
		async () => {
			await importAssetFromUrl(name, url);
		},
		// The URL is deliberately absent: this is the one field an operator types that routinely
		// carries credentials, and the record has no delete path. The name says which image it became.
		{ target: { kind: "asset", label: name } },
	);
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
	return assetAction(
		"assets:rename",
		async () => {
			await renameStoredAsset(id, name);
		},
		{ target: { kind: "asset", id, label: name } },
	);
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
	const id = formData.get("id");
	return assetAction(
		"assets:replace",
		async () => {
			const file = formData.get("file");
			if (!(file instanceof File) || file.size === 0) {
				throw new ApiError("missing_field", "Choose an image to upload.");
			}
			await requireWithinByteCap(file.size);

			await replaceStoredAsset(typeof id === "string" ? id : "", Buffer.from(await file.arrayBuffer()));
		},
		{ target: { kind: "asset", id: typeof id === "string" ? id : null } },
	);
}

/**
 * Replaces an image's bytes with one fetched from a URL, keeping its name.
 *
 * @param id the asset to replace
 * @param url where to fetch the new image from
 * @returns the state to render
 */
export async function replaceAssetFromUrl(id: string, url: string): Promise<ActionState> {
	return assetAction(
		"assets:replace-from-url",
		async () => {
			await replaceStoredAssetFromUrl(id, url);
		},
		// The URL stays out, for the reason `importAsset` gives.
		{ target: { kind: "asset", id } },
	);
}

/**
 * Deletes an image.
 *
 * @param id the asset to delete
 * @returns the state to render
 */
export async function removeAsset(id: string): Promise<ActionState> {
	return assetAction("assets:delete", () => deleteAsset(id), { target: { kind: "asset", id } });
}
