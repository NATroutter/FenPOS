"use client";

import { Pause, Play } from "lucide-react";
import { createContext, type ReactNode, useContext, useMemo, useState } from "react";
import { Toggle } from "@/components/ui/toggle";

/**
 * Whether the Logs tab is taking new lines into the view, shared between the control that sets it
 * and the list it governs.
 *
 * The two are siblings under a server component, so the state cannot be lifted into a common
 * client parent without dragging the whole page across the boundary. A context keeps the page's
 * shape and lets the control sit where an operator looks for it — on the row with the filters —
 * rather than above the list it happens to govern.
 *
 * This is not the header's live chip and does not replace it. That one closes the panel's whole
 * event subscription; this one decides whether the log a person is currently reading holds still,
 * which is a different question and comes up while the rest of the panel should keep moving.
 */
interface Follow {
	/** The operator's choice. */
	following: boolean;
	/** Whether following is meaningful here at all — see {@link FollowProvider}. */
	streamable: boolean;
	setFollowing: (following: boolean) => void;
}

const FollowContext = createContext<Follow | null>(null);

/**
 * @param streamable the server's verdict on whether this view can stream. A filtered or paged view
 *   is showing a fixed set of rows chosen by a query, and lines arriving into it unfiltered would
 *   contradict what the filter claims the view contains. Following is offered only where it means
 *   something.
 */
export function FollowProvider({ streamable, children }: { streamable: boolean; children: ReactNode }) {
	// On by default: a log tab that had to be switched on before it showed anything new would look
	// broken during the minute it matters.
	const [following, setFollowing] = useState(true);

	const value = useMemo<Follow>(() => ({ following, streamable, setFollowing }), [following, streamable]);

	return <FollowContext.Provider value={value}>{children}</FollowContext.Provider>;
}

export function useFollow(): Follow {
	const context = useContext(FollowContext);
	if (!context) {
		throw new Error("useFollow must be used inside FollowProvider");
	}
	return context;
}

/**
 * The control: pressed while new lines are being taken into the view.
 *
 * A `Toggle` rather than a button, for the same reason the header chip is one — the pressed state
 * is the stream's state, so the control and the indicator are one element and cannot disagree.
 *
 * The icon names the state, not the action: play while lines are running in, pause while the view
 * is held. That is the header chip's convention, and the opposite one — showing what a click would
 * do — puts a pause icon on a view that is already paused.
 */
export function FollowToggle() {
	const { following, streamable, setFollowing } = useFollow();
	const on = streamable && following;

	let title: string;
	if (!streamable) {
		title = "Following is unavailable while a filter or page is applied.";
	} else if (on) {
		title = "Following — new lines appear as they arrive. Click to hold the view still.";
	} else {
		title = "Not following — the view is holding still. Click to take new lines again.";
	}

	return (
		<Toggle
			variant="outline"
			pressed={on}
			disabled={!streamable}
			onPressedChange={setFollowing}
			aria-label={on ? "Stop following the log" : "Follow the log"}
			title={title}
			className="gap-1.5 text-[12px]"
		>
			{on ? <Play className="text-subtle-foreground" /> : <Pause className="text-subtle-foreground" />}
			Follow
		</Toggle>
	);
}
