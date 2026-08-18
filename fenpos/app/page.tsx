import { redirect } from "next/navigation";

/**
 * The root path has no content of its own.
 *
 * Redirecting rather than rendering keeps one canonical URL per section, so a bookmark and a
 * sidebar link always agree. The panel layout performs the session check, so an
 * unauthenticated visitor is forwarded on to sign-in from there.
 */
export default function RootPage() {
	redirect("/dashboard");
}
