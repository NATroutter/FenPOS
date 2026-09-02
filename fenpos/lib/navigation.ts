import type { LucideIcon } from "lucide-react";
import {
	Archive,
	BookOpen,
	Braces,
	ChartColumn,
	CodeXml,
	History,
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
	Shield,
	ShieldCheck,
	Users,
	Wrench,
} from "lucide-react";
import type { PanelPermission } from "@/lib/domain/panel-permissions";

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
	 * The permission that reveals this section and that its page requires — or, for a section showing
	 * two things that are governed separately, the permissions **any one** of which does.
	 *
	 * Declared beside the route rather than in a second table, so a section added without deciding
	 * who may see it is a type error rather than a section everyone can see. The sidebar filters on
	 * it; the page's own `requirePagePermission` is the boundary.
	 *
	 * **A list means "any of", never "all of".** `/archives` is the case it exists for: it lists
	 * archived log periods and archived audit periods side by side, so an account holding either has
	 * something to read there, and requiring both would hide the log archives from an auditor and the
	 * audit archives from an operator. Revealing the section is not deciding what is in it — which
	 * periods a caller may actually see is still settled one at a time, by the actions behind the page.
	 *
	 * One permission stays one permission: the list form is rare enough that writing it should read as
	 * the deliberate exception it is.
	 */
	permission: PanelPermission | readonly PanelPermission[];
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
 * Grouped by what the operator is doing rather than by data model: watching what the system did,
 * managing the hardware, curating what receipts print, deciding who may act, and configuring the
 * install. Five small groups rather than three big ones, because a seven-item "Administration"
 * had stopped saying anything about what was inside it — and it split the record pages, leaving
 * Audit a group away from the Logs and Archives it belongs beside.
 */
export const NAV_GROUPS: readonly NavGroup[] = [
	{
		label: "Monitor",
		items: [
			{
				href: "/dashboard",
				label: "Dashboard",
				title: "Dashboard",
				description: "What is reachable now, and what the last day produced.",
				icon: LayoutDashboard,
				permission: "dashboard:read",
			},
			{
				href: "/statistics",
				label: "Statistics",
				title: "Statistics",
				description: "What the system did over time: throughput, reliability, latency, fleet health.",
				icon: ChartColumn,
				permission: "stats:read",
			},
			{
				href: "/jobs",
				label: "Jobs",
				title: "Print jobs",
				description: "Every job and what became of it. A job that failed carries the agent's own words about why.",
				icon: ListOrdered,
				permission: "jobs:read",
			},
			{
				href: "/logs",
				label: "Logs",
				title: "Logs",
				description: "What the agents forwarded. Each also keeps its own complete log on the machine it runs on.",
				icon: ScrollText,
				permission: "logs:read",
			},
			{
				href: "/audit",
				label: "Audit",
				title: "Audit record",
				description:
					"Who did what, and what came of it. Append-only and hash-chained: there is no edit control here because there is no edit path.",
				icon: History,
				permission: "audit:read",
			},
			{
				href: "/archives",
				label: "Archives",
				title: "Archived periods",
				description:
					"Whole months moved out of the live databases into compressed files. Opened one at a time, on request.",
				icon: Archive,
				// Either permission, because the tab lists both kinds of archived period and an account
				// holding one of them has something to read here. Naming only `logs:read` would send an
				// auditor who holds `audit:read` to `/no-access` and then tell them, on the one page whose
				// job is saying where the record went, that there was nothing to see. What each caller may
				// actually open is still decided per period by the actions behind this page.
				permission: ["logs:read", "audit:read"],
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
				permission: "agents:read",
			},
			{
				href: "/devices",
				label: "Devices",
				title: "Configured printers",
				description:
					"Each printer belongs to one agent. Names need only be unique within their agent, so every site can have its own kitchen.",
				icon: Printer,
				permission: "devices:read",
			},
			{
				href: "/tools",
				label: "Tools",
				title: "Tools",
				description: "Compose a receipt and see where it lands on the paper, or send bytes straight to a printer.",
				icon: Wrench,
				permission: "tools:read",
			},
		],
	},
	{
		label: "Content",
		items: [
			{
				href: "/assets",
				label: "Assets",
				title: "Assets",
				description:
					"Images receipts can print. Referenced from markup by name, and pushed to the agents that need them.",
				icon: ImageIcon,
				permission: "assets:read",
			},
			{
				href: "/variables",
				label: "Variables",
				title: "Variables",
				description:
					"Values receipts refer to by name. Written as {name} in markup and filled in when the receipt is printed, so a phone number or an address is changed in one place.",
				icon: Braces,
				permission: "variables:read",
			},
		],
	},
	{
		label: "Access",
		items: [
			{
				href: "/users",
				label: "Users",
				title: "Users",
				description:
					"Panel accounts and what each may do. Nothing is emailed: whoever creates an account delivers the credentials themselves.",
				icon: Users,
				permission: "users:read",
			},
			{
				href: "/roles",
				label: "Roles",
				title: "Roles",
				description:
					"Bundles of permissions several people share. Editing a role changes what every member can do, immediately.",
				icon: Shield,
				permission: "roles:read",
			},
			{
				href: "/keys",
				label: "API keys",
				title: "API keys",
				description:
					"Keys for machines that print. Each is shown once when created and stored only as a hash, so a lost key is replaced rather than recovered.",
				icon: KeyRound,
				permission: "keys:read",
			},
		],
	},
	{
		label: "System",
		items: [
			{
				href: "/settings",
				label: "Settings",
				title: "Settings",
				description:
					"Install-wide defaults. Per-printer settings are on the Devices tab, and your password is under your profile in the sidebar.",
				icon: Settings2,
				permission: "settings:read",
			},
			{
				href: "/docs",
				label: "Docs",
				title: "Documentation",
				description: "How to drive this install from another system, and how to write what it prints.",
				icon: BookOpen,
				permission: "docs:read",
				children: [
					{
						href: "/docs/api",
						label: "API",
						title: "API documentation",
						description: "The print API, as this install serves it.",
						icon: Plug,
						permission: "docs:read",
					},
					{
						href: "/docs/markup",
						label: "Markup",
						title: "Markup language",
						description: "What goes inside a job's data: the tags a receipt is written with, and the blocks they draw.",
						icon: CodeXml,
						permission: "docs:read",
					},
					{
						href: "/docs/security",
						label: "Security",
						title: "Security",
						description: "Signing in, two-factor, sessions and how to recover an install nobody can sign in to.",
						icon: ShieldCheck,
						permission: "docs:read",
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
