import Image from "next/image";
import { cn } from "@/lib/utils";

/** The tile, the mark inside it, and the type set beside them, at each variant. */
const VARIANTS = {
	default: { tile: "size-9 rounded-[10px]", mark: 30, name: "text-base" },
	compact: { tile: "size-8 rounded-[9px]", mark: 30, name: "text-[15px]" },
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
		<div className={cn("flex items-center gap-1", className)}>
			{/* The artwork is itself a brand-red tile with its own rounded edge, so this box paints
			    nothing: a background behind it would show as a rim of a second colour where the
			    artwork's corners fall away, and an outline would trace this box rather than the shape
			    inside it. What is left is a fixed square the type sits beside, which is what keeps the
			    lockup the same height whatever the artwork's own proportions turn out to be. */}
			<div className={cn("grid shrink-0 place-items-center", variant.tile)}>
				{/* Empty alt: the name is right beside it, so a screen reader announcing the mark as
				    well would read the product name twice. */}
				<Image src="/fenpos-logo.png" alt="" width={variant.mark} height={variant.mark} priority />
			</div>
			{/* Tagged so a caller can hide the type without hiding the mark. The sidebar does exactly
			    that when it collapses to icons: 48px of rail has no room for a wordmark, and left in
			    place it spilled out over the page header beside it. */}
			<div data-slot="brand-name" className="min-w-0">
				<div className={cn("font-semibold leading-none tracking-tight", variant.name)}>FenPOS</div>
				{caption ? (
					<div className="mt-0 font-mono text-[11px] leading-none text-subtle-foreground">{caption}</div>
				) : null}
			</div>
		</div>
	);
}
