"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/app/(panel)/agents/action-state";
import { requireSession } from "@/lib/auth/require-session";
import { ApiError } from "@/lib/errors";
import {
	createApiKey as createApiKeyRecord,
	deleteApiKey as deleteApiKeyRecord,
	renameApiKey as renameApiKeyRecord,
	rerollApiKey as rerollApiKeyRecord,
	revokeApiKey as revokeApiKeyRecord,
	updateApiKeyGrants,
} from "@/lib/keys/key-service";
import { logger } from "@/lib/logger";

/**
 * Server actions behind the Keys tab.
 *
 * Every action re-checks the session. The panel layout already guards the page, but an action is
 * a POST endpoint in its own right: anything that trusted the layout would be callable directly
 * by anyone who knew the action id.
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
		revalidatePath("/keys");
		return { error: null };
	} catch (error) {
		if (error instanceof ApiError) {
			return { error: error.message };
		}
		logger.error(`Key action failed: ${label}`, error);
		return { error: "Something went wrong. Check the server log." };
	}
}

/** The outcome of minting or reissuing a key, carrying the one and only sight of its secret. */
export interface MintedKeyResult {
	error: string | null;
	/** The full key. Shown once and never recoverable; null when creation failed. */
	secret: string | null;
}

/**
 * Mints a key and returns its secret once.
 *
 * The secret comes back through the action's return value rather than being stored anywhere for
 * the page to read later. There is no later: the database holds only a hash, so a panel that
 * could redisplay it would mean a database dump was a set of working credentials.
 *
 * @param name what to call it in the panel
 * @param permissions what it may do
 * @param deviceIds which printers it may address
 * @returns the secret, or why it could not be created
 */
export async function createKey(name: string, permissions: string[], deviceIds: string[]): Promise<MintedKeyResult> {
	await requireSession();

	try {
		const key = await createApiKeyRecord(name, permissions, deviceIds);
		revalidatePath("/keys");
		return { error: null, secret: key.secret };
	} catch (error) {
		if (error instanceof ApiError) {
			return { error: error.message, secret: null };
		}
		logger.error("Key action failed: create", error);
		return { error: "Something went wrong. Check the server log.", secret: null };
	}
}

/**
 * Replaces a key's permissions and device grants.
 *
 * @param keyId the key to change
 * @param permissions what it may do from now on
 * @param deviceIds which printers it may address from now on
 * @returns the state to render
 */
export async function updateKey(keyId: string, permissions: string[], deviceIds: string[]): Promise<ActionState> {
	return run("update", () => updateApiKeyGrants(keyId, permissions, deviceIds));
}

/**
 * Issues a new secret for a key and returns it once.
 *
 * Same one-sight-only contract as {@link createKey}, for the same reason: nothing stores it.
 *
 * @param keyId the key to reissue
 * @returns the new secret, or why it could not be issued
 */
export async function rerollKey(keyId: string): Promise<MintedKeyResult> {
	await requireSession();

	try {
		const key = await rerollApiKeyRecord(keyId);
		revalidatePath("/keys");
		return { error: null, secret: key.secret };
	} catch (error) {
		if (error instanceof ApiError) {
			return { error: error.message, secret: null };
		}
		logger.error("Key action failed: reroll", error);
		return { error: "Something went wrong. Check the server log.", secret: null };
	}
}

/**
 * Renames a key.
 *
 * @param keyId the key to rename
 * @param name the new name
 * @returns the state to render
 */
export async function renameKey(keyId: string, name: string): Promise<ActionState> {
	return run("rename", () => renameApiKeyRecord(keyId, name));
}

/**
 * Revokes a key, immediately and irreversibly.
 *
 * @param keyId the key to revoke
 * @returns the state to render
 */
export async function revokeKey(keyId: string): Promise<ActionState> {
	return run("revoke", () => revokeApiKeyRecord(keyId));
}

/**
 * Deletes a key and its grants.
 *
 * @param keyId the key to delete
 * @returns the state to render
 */
export async function deleteKey(keyId: string): Promise<ActionState> {
	return run("delete", () => deleteApiKeyRecord(keyId));
}
