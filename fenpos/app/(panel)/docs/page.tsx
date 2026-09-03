import { redirect } from "next/navigation";

/**
 * `/docs`, no page of its own.
 *
 * With several children a landing page here would be a menu repeating the sidebar, so the path
 * serves the first of them instead. It exists at all for the bookmarks and links that predate the
 * split. Anyone who had deep-linked to `#markup` or `#blocks` loses the anchor, which is acceptable
 * for an install-local admin panel.
 *
 * A temporary redirect rather than a permanent one: guides are coming, and a `308` cached in every
 * browser that ever hit `/docs` is what would stop this path becoming a real landing page later.
 *
 * **No permission gate of its own, and that is not an omission.** This renders nothing and reads
 * nothing. It hands the caller to `/docs/api`, which requires `docs:read` before it renders a word.
 * Gating here as well would only mean an account without `docs:read` reached `/no-access` one
 * redirect sooner. When this becomes a real landing page, it needs the gate.
 */
export default function DocsPage(): never {
	redirect("/docs/api");
}
