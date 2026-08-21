import type { LucideIcon } from "lucide-react";
import {
	BookOpen,
	CodeXml,
	// `Image` is also a DOM global, and one that a React file legitimately reaches for. Aliased so
	// the name in this file can only mean the icon.
	Image as ImageIcon,
	KeyRound,
	LayoutDashboard,
	ListOrdered,
	Plug,
	Printer,
	ScrollText,
	Server,
	Settings2,
	Wrench,
} from "lucide-react";

/**
 * The panel's navigation structure and page titles.
 *
 * Declared once here rather than duplicated across the sidebar and each page, so a route
 * cannot end up with a heading that disagrees with the sidebar entry that reached it.
 */

/** One navigable section. */
export interface NavItem {
	/** Route path, which is also the key used to find the active entry. */
	href: string;
	/** Sidebar label. */
	label: string;
	/** Heading shown at the top of the page, when it differs from the sidebar label. */
	title: string;
	/**
	 * One sentence on what the section is for, shown under the heading in the top bar.
	 *
	 * Lives here rather than on each page because it belongs to the section, not to whatever the
	 * page happens to render — a page that grew a second card would otherwise have a description
	 * describing only its first. Plain text: it is set in a bar the page does not control.
	 */
	description: string;
	icon: LucideIcon;
	/**
	 * Sections nested under this one in the sidebar.
	 *
	 * A parent with children is a group rather than a destination: the sidebar renders it as a
	 * collapsible trigger, and its own `href` exists so the group can tell whether the current path
	 * is inside it — and, for `/docs`, so the redirect that path serves still has a table entry.
	 */
	children?: readonly NavItem[];
}

/** A labelled group of sections in the sidebar. */
export interface NavGroup {
	label: string;
	items: readonly NavItem[];
}

/**
 * Sidebar groups, in display order.
 *
 * Grouped by what the operator is doing rather than by data model: watching the system,
 * managing the hardware, or administering access.
 */
export const NAV_GROUPS: readonly NavGroup[] = [
	{
		label: "Operations",
		items: [
			{
				href: "/dashboard",
				label: "Dashboard",
				title: "Dashboard",
				description: "What is reachable now, and what the last day produced.",
				icon: LayoutDashboard,
			},
			{
				href: "/jobs",
				label: "Jobs",
				title: "Print jobs",
				description: "Every job and what became of it. A job that failed carries the agent's own words about why.",
				icon: ListOrdered,
			},
			{
				href: "/logs",
				label: "Logs",
				title: "Logs",
				description: "What the agents forwarded. Each also keeps its own complete log on the machine it runs on.",
				icon: ScrollText,
			},
		],
	},
	{
		label: "Hardware",
		items: [
			{
				href: "/agents",
				label: "Agents",
				title: "Agents",
				description:
					"Each agent is one machine with printers attached. Agents dial the server, so no inbound port needs opening at the site.",
				icon: Server,
			},
			{
				href: "/devices",
				label: "Devices",
				title: "Configured printers",
				description:
					"Each printer belongs to one agent. Names need only be unique within their agent, so every site can have its own kitchen.",
				icon: Printer,
			},
			{
				href: "/tools",
				label: "Tools",
				title: "Tools",
				description: "Compose a receipt and see where it lands on the paper, or send bytes straight to a printer.",
				icon: Wrench,
			},
		],
	},
	{
		label: "Administration",
		items: [
			{
				href: "/keys",
				label: "API keys",
				title: "API keys",
				description:
					"Keys for machines that print. Each is shown once when created and stored only as a hash, so a lost key is replaced rather than recovered.",
				icon: KeyRound,
			},
			{
				href: "/assets",
				label: "Assets",
				title: "Assets",
				description:
					"Images receipts can print. Referenced from markup by name, and pushed to the agents that need them.",
				icon: ImageIcon,
			},
			{
				href: "/settings",
				label: "Settings",
				title: "Settings",
				description:
					"Install-wide defaults. Per-printer settings are on the Devices tab, and the administrator password is under your profile in the sidebar.",
				icon: Settings2,
			},
			{
				href: "/docs",
				label: "Docs",
				title: "Documentation",
				description: "How to drive this install from another system, and how to write what it prints.",
				icon: BookOpen,
				children: [
					{
						href: "/docs/api",
						label: "API",
						title: "API documentation",
						description: "The print API, as this install serves it.",
						icon: Plug,
					},
					{
						href: "/docs/markup",
						label: "Markup",
						title: "Markup language",
						description: "What goes inside a job's data: the tags a receipt is written with, and the blocks they draw.",
						icon: CodeXml,
					},
				],
			},
		],
	},
];

/** Every section, flattened — children as well as the groups' own items. */
export const NAV_ITEMS: readonly NavItem[] = NAV_GROUPS.flatMap((group) =>
	group.items.flatMap((item) => [item, ...(item.children ?? [])]),
);

/**
 * Finds the section a path belongs to.
 *
 * Matches on the path prefix so that nested routes, such as a device detail page, still resolve to
 * the section that owns them — and takes the **longest** matching href, because with children
 * flattened in, `/docs/api` matches both itself and its parent `/docs`. Taking the first match
 * would put the parent's title on every child page.
 *
 * @param pathname the current route
 * @returns the owning section, or undefined for a path outside the panel
 */
export function findNavItem(pathname: string): NavItem | undefined {
	let best: NavItem | undefined;
	for (const item of NAV_ITEMS) {
		if (pathname !== item.href && !pathname.startsWith(`${item.href}/`)) {
			continue;
		}
		if (!best || item.href.length > best.href.length) {
			best = item;
		}
	}
	return best;
}
