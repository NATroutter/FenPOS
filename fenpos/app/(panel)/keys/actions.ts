"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/app/(panel)/agents/action-state";
import { requireSession } from "@/lib/auth/require-session";
import { prisma } from "@/lib/db";
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
import { assertDeliverable } from "@/lib/webhooks/deliver";
import { newWebhookSecret } from "@/lib/webhooks/signature";

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

/**
 * Registers or replaces a key's webhook subscription, returning its secret once.
 *
 * **This is a panel action rather than an API endpoint on purpose.** A key that could point its
 * own webhook anywhere could redirect another integrator's notifications if it leaked — aiming a
 * webhook is a decision about where *this install's* data goes, not something a caller should be
 * able to do to itself. So it runs behind an admin session, like every other action in this file.
 *
 * The target is checked with {@link assertDeliverable}, the exact function the delivery loop
 * calls before every attempt, so a URL this accepts can never turn out to be one delivery goes on
 * to refuse — an operator learns a target is unreachable now, not from a failed-delivery log
 * later. **The refusal is returned, not thrown**, and deliberately shares {@link MintedKeyResult}
 * with {@link createKey} and {@link rerollKey} rather than rejecting: a thrown error crossing a
 * Server Action boundary has its message redacted in a production build, which would turn "this
 * install only delivers webhooks over https" into a generic failure the operator cannot act on —
 * exactly the outcome validating at registration exists to avoid.
 *
 * **Replacing an existing subscription issues a brand new secret.** There is no "keep the current
 * secret, just change the URL" path: rotating and re-registering are the same action here, the
 * same way {@link rerollKey} is the only way to change a key's secret. The old secret simply stops
 * being the one this server signs with.
 *
 * @param apiKeyId the key the subscription belongs to
 * @param url the target to deliver to
 * @returns the new secret, or why it could not be registered
 */
export async function setWebhook(apiKeyId: string, url: string): Promise<MintedKeyResult> {
	await requireSession();

	try {
		await assertDeliverable(url);

		const secret = newWebhookSecret();
		await prisma.webhook.upsert({
			where: { apiKeyId },
			create: { apiKeyId, url, secret },
			update: { url, secret },
		});

		logger.info("Webhook registered", { apiKeyId });
		revalidatePath("/keys");
		return { error: null, secret };
	} catch (error) {
		if (error instanceof ApiError) {
			return { error: error.message, secret: null };
		}
		logger.error("Key action failed: setWebhook", error);
		return { error: "Something went wrong. Check the server log.", secret: null };
	}
}

/**
 * Removes a key's webhook subscription.
 *
 * Deleting the row cascades to every delivery still queued for it (`onDelete: Cascade` on
 * `WebhookDelivery.webhookId`), so removing a subscription cannot leave orphaned deliveries a
 * disabled or deleted target will never receive.
 *
 * `deleteMany` rather than `delete`: a key with no subscription is not an error here, it is the
 * common case for every key that never had one, and the operator's intent — "this key should have
 * no webhook" — is satisfied either way.
 *
 * @param apiKeyId the key whose subscription is removed
 * @returns the state to render
 */
export async function removeWebhook(apiKeyId: string): Promise<ActionState> {
	return run("removeWebhook", async () => {
		await prisma.webhook.deleteMany({ where: { apiKeyId } });
		logger.info("Webhook removed", { apiKeyId });
	});
}
