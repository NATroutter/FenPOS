import { TriangleAlert } from "lucide-react";
import Link from "next/link";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { isPasswordGenerated } from "@/lib/auth/admin";

/**
 * Warns, on every page, that the install is still using the password generated at first boot.
 *
 * Deliberately not dismissible. The generated password was printed to a log that scrolls away
 * and may be readable by anyone who can see the console output or the container's logs, so an
 * install left on it is one shoulder-glance from being taken over. A banner that could be
 * clicked away would be gone long before the password was changed.
 *
 * It renders nothing once an operator has set their own password: a permanent "you are secure"
 * ribbon trains people to ignore the strip of the page where the real warning appears. The
 * confirmation that the change took effect belongs on Settings, next to the control that did
 * it, and that is where it is.
 */
export async function PasswordBanner() {
	if (!(await isPasswordGenerated())) {
		return null;
	}

	return (
		<Alert variant="destructive" className="rounded-none border-x-0 border-t-0">
			<TriangleAlert />
			<AlertTitle>This install is using its generated password</AlertTitle>
			<AlertDescription>
				It was printed to the server log when FenPOS started, so treat it as known to anyone who can read that log.{" "}
				<Link href="/settings" className="font-medium underline underline-offset-2">
					Set your own password
				</Link>{" "}
				to clear this warning.
			</AlertDescription>
		</Alert>
	);
}
