import type { Metadata } from "next";
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
	title: "FenPOS",
	description: "Thermal printer management for FenPOS agents.",
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
