import Image from "next/image";
import { cn } from "@/lib/utils";

/** The tile, the mark inside it, and the type set beside them, at each variant. */
const VARIANTS = {
	default: { tile: "size-9 rounded-[10px]", mark: 26, name: "text-base" },
	compact: { tile: "size-8 rounded-[9px]", mark: 23, name: "text-[15px]" },
} as const;

/**
 * The FenPOS lockup: the product mark beside the product name.
 *
 * Shared between the sign-in page, the set-password page and the sidebar header so the three
 * cannot drift apart. It replaced a plain brand-coloured square, which was a placeholder that
 * outlived the point at which a real mark existed.
 *
 * The PNG rather than the SVG: `next/image` refuses to optimise SVG unless the app opts into
 * serving arbitrary SVG through the optimiser, and a global switch loosening what the image
 * pipeline will render is not worth paying for one logo that is never displayed above 34px.
 */
export function BrandMark({
	className,
	size = "default",
	caption,
}: {
	className?: string;
	/** `compact` is the sidebar variant, a shade smaller than the auth pages. */
	size?: "default" | "compact";
	/**
	 * Small line under the name — the version, in the sidebar.
	 *
	 * Part of the lockup rather than a sibling below it, so the mark's height is spent on two
	 * lines of type instead of leaving the name floating beside a tall square.
	 */
	caption?: string;
}) {
	const variant = VARIANTS[size];

	return (
		<div className={cn("flex items-center gap-2.5", className)}>
			{/* The mark is a dark charcoal printer, and the panel is near-black — on its own it sank
			    into whatever it sat on. The tile is the surface the mark was drawn for, which is also
			    how it appears as an app icon, and it makes the lockup the one lit thing in a dark
			    sidebar rather than a shape you have to look for. */}
			<div className={cn("grid shrink-0 place-items-center bg-brand ring-1 ring-black/10", variant.tile)}>
				{/* Empty alt: the name is right beside it, so a screen reader announcing the mark as
				    well would read the product name twice. */}
				<Image src="/fenpos-logo.png" alt="" width={variant.mark} height={variant.mark} priority />
			</div>
			<div className="min-w-0">
				<div className={cn("font-semibold leading-none tracking-tight", variant.name)}>FenPOS</div>
				{caption ? (
					<div className="mt-1 font-mono text-[11px] leading-none text-subtle-foreground">{caption}</div>
				) : null}
			</div>
		</div>
	);
}
