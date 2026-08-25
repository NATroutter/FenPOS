import { KeyRound, Plus } from "lucide-react";
import { KeyDialog } from "@/app/(panel)/keys/key-dialog";
import { KeyRow, type KeyRowData } from "@/app/(panel)/keys/key-row";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { API_BASE } from "@/lib/api-version";
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
 */
export default async function KeysPage() {
	// Outside any try: both an absent session and a refusal signal by throwing.
	await requirePagePermission("keys:read");

	const [keys, devices, webhooks] = await Promise.all([
		listApiKeys(),
		prisma.device.findMany({
			orderBy: [{ agent: { name: "asc" } }, { name: "asc" }],
			select: { id: true, name: true, agent: { select: { name: true } } },
		}),
		prisma.webhook.findMany({ select: { apiKeyId: true, url: true } }),
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
		webhook: webhookByKeyId.get(key.id) ?? null,
	}));

	return (
		<div className="flex flex-col gap-5">
			{/* The section's own description is in the top bar; what is left here is the one action
			    this page offers, kept on its own row so it stays put as the list below changes. */}
			<div className="flex justify-end">
				<KeyDialog
					devices={grantable}
					trigger={
						<Button>
							<Plus className="size-3.5" />
							New key
						</Button>
					}
				/>
			</div>

			{rows.length === 0 ? (
				<Empty className="border border-dashed border-border">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<KeyRound />
						</EmptyMedia>
						<EmptyTitle>No keys yet</EmptyTitle>
						<EmptyDescription>
							Create one to let a till or an ordering system submit jobs to{" "}
							<span className="font-mono">POST {API_BASE}/print/&#123;agent&#125;/&#123;device&#125;</span>.
						</EmptyDescription>
					</EmptyHeader>
				</Empty>
			) : (
				<div className="flex flex-col gap-4">
					{rows.map((key) => (
						<KeyRow key={key.id} apiKey={key} devices={grantable} />
					))}
				</div>
			)}
		</div>
	);
}
