import { cn } from "@/lib/utils";

/**
 * The FenPOS wordmark: a small brand-coloured square beside the product name.
 *
 * Shared between the sign-in page and the sidebar header so the two cannot drift apart.
 */
export function BrandMark({
	className,
	size = "default",
}: {
	className?: string;
	/** `compact` is the sidebar variant, a shade smaller than the sign-in page. */
	size?: "default" | "compact";
}) {
	const compact = size === "compact";

	return (
		<div className={cn("flex items-center gap-2.5", className)}>
			<div aria-hidden className={cn("shrink-0 rounded-[4px] bg-brand", compact ? "size-[13px]" : "size-3.5")} />
			<span className={cn("font-semibold tracking-tight", compact ? "text-[15px]" : "text-base")}>FenPOS</span>
		</div>
	);
}
