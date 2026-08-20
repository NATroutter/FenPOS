import type { Metadata, Viewport } from "next";
import { Archivo } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import "../styles/globals.css";

/**
 * Archivo, as specified by the design.
 *
 * Loaded through next/font so the file is self-hosted and hashed at build time: the panel
 * must render correctly on a shop network with no route to Google, and a webfont fetched at
 * runtime would leak every page view to a third party.
 */
const archivo = Archivo({
	variable: "--font-sans",
	subsets: ["latin"],
	weight: ["400", "500", "600", "700"],
	display: "swap",
});

export const metadata: Metadata = {
	// Each page sets only its own name; the suffix is applied here so a new page cannot arrive
	// with the product name spelled differently or left off the tab entirely.
	title: { default: "FenPOS", template: "%s · FenPOS" },
	description: "Thermal printer management for FenPOS agents.",
	applicationName: "FenPOS",
	icons: {
		// Several sizes rather than one, because a browser picking the nearest and scaling is what
		// makes a favicon look smudged in the tab strip.
		icon: [
			{ url: "/fenpos-icon-x16.ico", sizes: "16x16" },
			{ url: "/fenpos-icon-x32.ico", sizes: "32x32" },
			{ url: "/fenpos-icon-x48.ico", sizes: "48x48" },
			{ url: "/fenpos-icon-x64.ico", sizes: "64x64" },
			{ url: "/fenpos-icon-x128.ico", sizes: "128x128" },
		],
		apple: { url: "/fenpos-logo.png", sizes: "180x180" },
	},
	// This is an administration panel for one install, reachable on a shop network. Nothing here
	// is for the public, and a crawler that found it would be indexing the door to the printers.
	robots: { index: false, follow: false },
};

/**
 * Matches the page background, so the browser's own chrome does not frame a dark panel in white
 * on the devices that colour it.
 */
export const viewport: Viewport = {
	themeColor: "#0a0a0a",
	colorScheme: "dark",
};

/**
 * Root document.
 *
 * The `dark` class is fixed rather than toggled. The panel has one theme, so there is no
 * preference to read and no hydration mismatch to guard against.
 */
export default function RootLayout({ children }: LayoutProps<"/">) {
	return (
		<html lang="en" className={`${archivo.variable} dark h-full antialiased`}>
			<body className="flex min-h-full flex-col bg-background text-foreground">
				{children}
				<Toaster position="bottom-right" />
			</body>
		</html>
	);
}
