import { redirect } from "next/navigation";
import { SetupForm } from "@/app/(auth)/setup/setup-form";
import { MINIMUM_PASSWORD_LENGTH } from "@/lib/auth/password-policy";
import { isInstallClaimed } from "@/lib/auth/setup-key";

/**
 * Never prerendered: whether this page exists at all depends on the database.
 */
export const dynamic = "force-dynamic";

/**
 * The page that claims an install.
 *
 * The redirect below is convenience, not the boundary — an operator who bookmarked this URL and
 * came back after setup should land somewhere useful rather than on a form that would refuse them.
 * What actually stops a second setup is the transaction in `lib/auth/setup.ts`, which re-checks
 * everything this page checked and does not trust that this page ran at all.
 */
export default async function SetupPage() {
	if (await isInstallClaimed()) {
		redirect("/login");
	}

	return <SetupForm minimumPasswordLength={MINIMUM_PASSWORD_LENGTH} />;
}
