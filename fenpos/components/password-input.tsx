"use client";

import { Eye, EyeOff } from "lucide-react";
import type * as React from "react";
import { useState } from "react";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";

/**
 * A password field with a reveal toggle.
 *
 * Masking protects against someone reading over a shoulder, which is a real risk in a shop
 * back office; it does nothing about the far more common problem of typing a long passphrase
 * blind and being told only afterwards that it did not match. The toggle lets the operator
 * decide which of the two they are actually up against.
 *
 * Starts masked every time — the reveal is a deliberate act, never a remembered preference.
 */
export function PasswordInput({
	className,
	groupClassName,
	...props
}: Omit<React.ComponentProps<"input">, "type"> & { groupClassName?: string }) {
	const [revealed, setRevealed] = useState(false);

	return (
		<InputGroup className={groupClassName}>
			<InputGroupInput {...props} type={revealed ? "text" : "password"} className={className} />
			<InputGroupAddon align="inline-end">
				<InputGroupButton
					size="icon-xs"
					// aria-pressed rather than a changing label alone, so the state is reported even
					// when the label is not re-announced.
					aria-pressed={revealed}
					aria-label={revealed ? "Hide password" : "Show password"}
					title={revealed ? "Hide password" : "Show password"}
					disabled={props.disabled}
					onClick={() => setRevealed((current) => !current)}
				>
					{revealed ? <EyeOff /> : <Eye />}
				</InputGroupButton>
			</InputGroupAddon>
		</InputGroup>
	);
}
