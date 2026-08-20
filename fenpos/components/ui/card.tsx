import type * as React from "react";

import { cn } from "@/lib/utils";

function Card({ className, size = "default", ...props }: React.ComponentProps<"div"> & { size?: "default" | "sm" }) {
	return (
		<div
			data-slot="card"
			data-size={size}
			className={cn(
				// `has-data-[slot=card-header]:pt-0` hands the top padding to the header, which owns
				// it now that the header is a tinted band: left on the card, that padding would
				// show as a stripe of body colour above the band. Same trick the footer already
				// uses at the other end.
				"group/card flex flex-col gap-(--card-spacing) overflow-hidden rounded-xl bg-card py-(--card-spacing) text-sm text-card-foreground ring-1 ring-foreground/15 [--card-spacing:--spacing(4)] has-data-[slot=card-header]:pt-0 has-data-[slot=card-footer]:pb-0 has-[>img:first-child]:pt-0 data-[size=sm]:[--card-spacing:--spacing(3)] data-[size=sm]:has-data-[slot=card-footer]:pb-0 *:[img:first-child]:rounded-t-xl *:[img:last-child]:rounded-b-xl",
				className,
			)}
			{...props}
		/>
	);
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="card-header"
			className={cn(
				// The band carries its own padding on all four sides, because it is now a filled
				// surface rather than an unmarked region of the card, and its own rule, because the
				// step from band to well wants a line drawn on it rather than left to the eye.
				// Callers that set their own `pb-*` still win, which several do.
				//
				// `min-h-16` is what makes every card's band the same depth. Left to its contents, a
				// header with a title alone came out visibly shallower than one with a title and a
				// line under it, so two cards side by side had their rules at different heights —
				// which reads as a mistake even when neither card is wrong on its own.
				"group/card-header @container/card-header grid min-h-16 auto-rows-min content-center items-start gap-1 rounded-t-xl border-b border-border bg-card-band px-(--card-spacing) py-(--card-spacing) has-data-[slot=card-action]:grid-cols-[1fr_auto] has-data-[slot=card-description]:grid-rows-[auto_auto] [.border-b]:pb-(--card-spacing)",
				className,
			)}
			{...props}
		/>
	);
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="card-title"
			className={cn("font-heading text-base leading-snug font-medium group-data-[size=sm]/card:text-sm", className)}
			{...props}
		/>
	);
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
	return <div data-slot="card-description" className={cn("text-sm text-muted-foreground", className)} {...props} />;
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="card-action"
			className={cn("col-start-2 row-span-2 row-start-1 self-start justify-self-end", className)}
			{...props}
		/>
	);
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
	// The well is tinted rather than left at the card's own colour, which lifts it a shade off the
	// page behind it without approaching either band. The card's `gap` still shows card colour
	// above and below, so the content reads as a panel inset between the two bands.
	return <div data-slot="card-content" className={cn("px-(--card-spacing)", className)} {...props} />;
}

/**
 * The row of controls at the bottom of a card, under a rule.
 *
 * A component rather than a class string repeated per card, because the requirement is that every
 * card's controls line up — and six copies of the same rule is exactly how they stop doing that.
 *
 * The row is as tall as its contents. Cards that sit side by side and must end level add a floor —
 * `min-h-17` clears the tallest content there, a label stacked over a control. It is not the
 * default, because a card whose row holds nothing but icon buttons then carries 36px of slack it
 * has no use for.
 *
 * `mt-auto` pins the row to the bottom of a card taller than its content. Override it with `mt-0`
 * where something deliberately sits below the row, or it will be pushed down against that instead.
 */
function CardActions({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="card-actions"
			className={cn("mt-auto flex flex-wrap items-center gap-3 border-t border-border pt-3", className)}
			{...props}
		/>
	);
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="card-footer"
			// The same band as the header, at the other end: controls that act on the card belong on
			// the card's chrome, not loose at the bottom of its content.
			//
			// `min-h-20` is what keeps every card's footer the same depth, the way `min-h-16` does
			// for headers. Left to its contents a footer holding a bare button came out 20px
			// shallower than one holding a labelled select, so two cards side by side ended at
			// different heights. 80px is the tallest footer content — a label stacked over a control,
			// 52px — plus the band's own padding.
			className={cn(
				"flex min-h-20 items-center gap-3 rounded-b-xl border-t border-border bg-card-band px-(--card-spacing) py-3",
				className,
			)}
			{...props}
		/>
	);
}

export { Card, CardHeader, CardActions, CardFooter, CardTitle, CardAction, CardDescription, CardContent };
