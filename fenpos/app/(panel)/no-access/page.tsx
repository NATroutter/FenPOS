import { PowerOff, ShieldOff } from "lucide-react";
import Link from "next/link";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { REFUSAL_MESSAGE } from "@/lib/auth/require-permission";
import { requireSession } from "@/lib/auth/require-session";
import { findNavItem } from "@/lib/navigation";
import { SETTINGS } from "@/lib/settings/settings-service";

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
 * Two refusals land here, told apart by the query. A permission refusal names nothing about what was
 * refused: the audit record holds that, and an operator staring at a page they cannot open does not
 * need this install's permission vocabulary read back to them. A section switched off in Settings
 * (`?off=<route>`) is the opposite case — the operator may well be the one who switched it off, and
 * the useful thing to say is which switch it was and where it lives.
 */
export default async function NoAccessPage({ searchParams }: { searchParams: Promise<{ off?: string }> }) {
	await requireSession();

	const { off } = await searchParams;
	// Only a route the navigation table knows, with a switch, is described. Anything else in the query
	// is treated as the plain refusal: this page must not become a way to make it print arbitrary text.
	const section = off ? findNavItem(off) : undefined;
	const definition = section?.feature ? SETTINGS.find((setting) => setting.key === section.feature) : undefined;

	if (section && definition) {
		return (
			<Empty>
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<PowerOff />
					</EmptyMedia>
					<EmptyTitle>{section.label} is switched off</EmptyTitle>
					<EmptyDescription>
						<span className="font-medium">{definition.label}</span> is off on the <Link href="/settings">Settings</Link>{" "}
						tab, so this section is not in use. Turn it on to bring the section back.
					</EmptyDescription>
				</EmptyHeader>
			</Empty>
		);
	}

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
