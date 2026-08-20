"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * The one and only sight of a key's secret, with a copy button.
 *
 * Shared by the two places a secret is ever produced — minting and rerolling — so the wording and
 * the affordance cannot drift apart. Nothing here holds the value beyond the render: the database
 * has only a hash, so if this leaves the screen uncopied the key has to be reissued.
 */
export function SecretPane({ secret }: { secret: string }) {
	const [copied, setCopied] = useState(false);

	return (
		<div className="flex gap-2">
			<Input readOnly value={secret} className="font-mono text-[12px]" />
			<Button
				type="button"
				variant="outline"
				size="icon"
				title="Copy"
				aria-label="Copy key"
				onClick={() => {
					void navigator.clipboard.writeText(secret);
					setCopied(true);
					toast.success("Key copied.");
				}}
			>
				{copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
			</Button>
		</div>
	);
}
