import { ShieldOff } from "lucide-react";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { REFUSAL_MESSAGE } from "@/lib/auth/require-permission";
import { requireSession } from "@/lib/auth/require-session";

export const metadata = { title: "Not permitted" };

/** Never prerendered: it renders only for a caller whose session was already resolved. */
export const dynamic = "force-dynamic";

/**
 * Where a refused page sends the operator.
 *
 * Reachable by every authenticated account, deliberately: it is the one panel route with no
 * permission of its own, because a refusal that could itself be refused is a loop. It still calls
 * `requireSession`, so a signed-out visitor goes to sign-in rather than reading this.
 *
 * It names nothing about what was refused. The audit record holds that, and an operator staring at
 * a page they cannot open does not need this install's permission vocabulary read back to them.
 */
export default async function NoAccessPage() {
	await requireSession();

	return (
		<Empty>
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<ShieldOff />
				</EmptyMedia>
				<EmptyTitle>Not permitted</EmptyTitle>
				<EmptyDescription>{REFUSAL_MESSAGE}</EmptyDescription>
			</EmptyHeader>
		</Empty>
	);
}
