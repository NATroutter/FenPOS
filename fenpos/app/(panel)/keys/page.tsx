import { Plus } from "lucide-react";
import type { KeyPermits, KeyRowData } from "@/app/(panel)/keys/key-data";
import { KeyDialog } from "@/app/(panel)/keys/key-dialog";
import { KeysTable } from "@/app/(panel)/keys/keys-table";
import { Button } from "@/components/ui/button";
import { userHolds } from "@/lib/auth/effective-permissions";
import { requirePagePermission } from "@/lib/auth/require-permission";
import { prisma } from "@/lib/db";
import { listApiKeys } from "@/lib/keys/key-service";

export const metadata = { title: "API keys" };

/** Never cached: last-used timestamps move without any request to this page causing it. */
export const dynamic = "force-dynamic";

/**
 * The Keys tab.
 *
 * Keys are how machines print. Each carries a set of permissions and a set of printers, and both
 * must be granted before it can do anything — a key with an empty list is inert, which is the
 * only safe default for a credential created before anyone has decided what it is for.
 *
 * What this page hands the client is more than the keys: it also hands down which of the tab's
 * actions the acting account may take, because a client component cannot read the database and "may
 * I offer this button" is a database question. That filtering is convenience. `panel-action.ts`
 * refuses each action again on the way in, and that is the boundary.
 */
export default async function KeysPage() {
	// Outside any try: both an absent session and a refusal signal by throwing.
	const user = await requirePagePermission("keys:read", "/keys");

	const [keys, devices, webhooks, permits] = await Promise.all([
		listApiKeys(),
		prisma.device.findMany({
			orderBy: [{ agent: { name: "asc" } }, { name: "asc" }],
			select: { id: true, name: true, agent: { select: { name: true } } },
		}),
		prisma.webhook.findMany({ select: { apiKeyId: true, url: true } }),
		resolvePermits(user),
	]);

	const grantable = devices.map((device) => ({
		id: device.id,
		name: device.name,
		agentName: device.agent.name,
	}));

	const webhookByKeyId = new Map(webhooks.map((webhook) => [webhook.apiKeyId, { url: webhook.url }]));

	const rows: KeyRowData[] = keys.map((key) => ({
		id: key.id,
		name: key.name,
		maskedHint: key.maskedHint,
		createdAt: key.createdAt.toISOString(),
		lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
		revokedAt: key.revokedAt?.toISOString() ?? null,
		permissions: key.permissions,
		devices: key.devices,
		createdByName: key.createdByName,
		webhook: webhookByKeyId.get(key.id) ?? null,
	}));

	return (
		<div className="flex flex-col gap-5">
			{/* The section's own description is in the top bar; what is left here is the one action
			    this page offers, kept on its own row so it stays put as the list below changes. */}
			<div className="flex justify-end">
				{permits.create ? (
					<KeyDialog
						devices={grantable}
						trigger={
							<Button>
								<Plus className="size-3.5" />
								New key
							</Button>
						}
					/>
				) : null}
			</div>

			<KeysTable keys={rows} devices={grantable} permits={permits} />
		</div>
	);
}

/**
 * Which of this tab's actions the acting account may take.
 *
 * Every one is a permission of its own, which is exactly why they used to be eight separate icon
 * buttons on every card. They gate sections of one screen now, which is a thing an operator can
 * read.
 *
 * @param user the acting account
 * @returns what to render
 */
async function resolvePermits(user: { id: string; isSuperuser: boolean }): Promise<KeyPermits> {
	const [create, update, rename, reroll, revoke, remove, setWebhook, removeWebhook] = await Promise.all([
		userHolds(user, "keys:create"),
		userHolds(user, "keys:update"),
		userHolds(user, "keys:rename"),
		userHolds(user, "keys:reroll"),
		userHolds(user, "keys:revoke"),
		userHolds(user, "keys:delete"),
		userHolds(user, "keys:webhook-set"),
		userHolds(user, "keys:webhook-remove"),
	]);
	return { create, update, rename, reroll, revoke, remove, setWebhook, removeWebhook };
}
