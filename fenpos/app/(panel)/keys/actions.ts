"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/app/(panel)/agents/action-state";
import { safeUrl } from "@/lib/assets/fetch-remote";
import { panelAction, panelQuery } from "@/lib/auth/panel-action";
import { REFUSAL_MESSAGE } from "@/lib/auth/require-permission";
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
 * Every action goes through the shared gate, which resolves the session, checks the permission its
 * registry entry names, runs the body, and records the attempt. Three of them return their secret
 * once and so go through `panelQuery` rather than `panelAction` — that is a fact about their return
 * type only: minting, rerolling and pointing a webhook are all recorded like any other command.
 *
 * **No secret ever reaches the record.** Not the key, not the webhook signing secret. What is
 * recorded is that a key was minted and what it was granted, which is what an incident is read for.
 */

/** What every action here refreshes on success. */
const revalidate = () => revalidatePath("/keys");

/**
 * Shapes a failure the way this tab's one-time-secret actions report one.
 *
 * @param error whatever the body threw
 * @param label what to log an unexpected failure as
 * @returns the result to render
 */
function mintFailure(error: unknown, label: string): MintedKeyResult {
	if (error instanceof ApiError) {
		return { error: error.message, secret: null };
	}
	logger.error(`Key action failed: ${label}`, error);
	return { error: "Something went wrong. Check the server log.", secret: null };
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
	return panelQuery<MintedKeyResult>(
		"keys:create",
		async (user) => {
			const key = await createApiKeyRecord(name, permissions, deviceIds, { id: user.id, name: user.name });
			return { error: null, secret: key.secret };
		},
		{
			refused: () => ({ error: REFUSAL_MESSAGE, secret: null }),
			failed: (error) => mintFailure(error, "create"),
			revalidate,
			target: { kind: "api-key", label: name },
			// What it may do, never what it is. The secret exists in one place for one moment.
			detail: { permissions, deviceCount: deviceIds.length },
		},
	);
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
	return panelAction("keys:update", () => updateApiKeyGrants(keyId, permissions, deviceIds), {
		revalidate,
		target: { kind: "api-key", id: keyId },
		detail: { permissions, deviceCount: deviceIds.length },
	});
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
	return panelQuery<MintedKeyResult>(
		"keys:reroll",
		async () => {
			const key = await rerollApiKeyRecord(keyId);
			return { error: null, secret: key.secret };
		},
		{
			refused: () => ({ error: REFUSAL_MESSAGE, secret: null }),
			failed: (error) => mintFailure(error, "reroll"),
			revalidate,
			target: { kind: "api-key", id: keyId },
		},
	);
}

/**
 * Renames a key.
 *
 * @param keyId the key to rename
 * @param name the new name
 * @returns the state to render
 */
export async function renameKey(keyId: string, name: string): Promise<ActionState> {
	return panelAction("keys:rename", () => renameApiKeyRecord(keyId, name), {
		revalidate,
		target: { kind: "api-key", id: keyId, label: name },
	});
}

/**
 * Revokes a key, immediately and irreversibly.
 *
 * @param keyId the key to revoke
 * @returns the state to render
 */
export async function revokeKey(keyId: string): Promise<ActionState> {
	return panelAction("keys:revoke", () => revokeApiKeyRecord(keyId), {
		revalidate,
		target: { kind: "api-key", id: keyId },
	});
}

/**
 * Deletes a key and its grants.
 *
 * @param keyId the key to delete
 * @returns the state to render
 */
export async function deleteKey(keyId: string): Promise<ActionState> {
	return panelAction("keys:delete", () => deleteApiKeyRecord(keyId), {
		revalidate,
		target: { kind: "api-key", id: keyId },
	});
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
	return panelQuery<MintedKeyResult>(
		"keys:webhook-set",
		async () => {
			await assertDeliverable(url);

			const secret = newWebhookSecret();
			await prisma.webhook.upsert({
				where: { apiKeyId },
				create: { apiKeyId, url, secret },
				update: { url, secret },
			});

			logger.info("Webhook registered", { apiKeyId });
			return { error: null, secret };
		},
		{
			refused: () => ({ error: REFUSAL_MESSAGE, secret: null }),
			failed: (error) => mintFailure(error, "setWebhook"),
			revalidate,
			target: { kind: "api-key", id: apiKeyId },
			// The destination is recorded — a URL this install now talks to is exactly what an incident
			// is read to find. The signing secret is not, and neither is a credential embedded in the
			// URL: `https://user:token@host/hook` is a legitimate thing to register, and an audit row is
			// permanent, hash-chained and has no delete path. `safeUrl` is what `deliver.ts` already puts
			// every logged URL through, so the two records now agree about what a destination is.
			detail: { url: safeUrl(url) },
		},
	);
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
	return panelAction(
		"keys:webhook-remove",
		async () => {
			await prisma.webhook.deleteMany({ where: { apiKeyId } });
			logger.info("Webhook removed", { apiKeyId });
		},
		{ revalidate, target: { kind: "api-key", id: apiKeyId } },
	);
}
