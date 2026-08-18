"use client";

import CodeMirror from "@uiw/react-codemirror";
import { Send } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { writeRaw } from "@/app/(panel)/tools/actions";
import { DevicePicker, type ToolDevice } from "@/app/(panel)/tools/device-picker";
import { editorTheme } from "@/app/(panel)/tools/editor-theme";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";

/** ESC/POS sequences worth having to hand, with what they do. */
const SNIPPETS: { label: string; bytes: string; note: string }[] = [
	{ label: "Initialise", bytes: "1B 40", note: "ESC @ — resets the printer to its defaults." },
	{ label: "Feed 3 lines", bytes: "1B 64 03", note: "ESC d n" },
	{ label: "Full cut", bytes: "1D 56 00", note: "GS V 0" },
	{ label: "Partial cut", bytes: "1D 56 01", note: "GS V 1" },
	{ label: "Open drawer", bytes: "1B 70 00 19 FA", note: "ESC p — pulse on pin 2." },
	{ label: "Status request", bytes: "10 04 01", note: "DLE EOT n — printer replies on the port." },
];

/**
 * The raw byte editor.
 *
 * **This is the one place in the system that hands arbitrary bytes to hardware.** There is no
 * permission that grants it: an API key cannot reach it at any grant level, and it is reachable
 * only from an admin session. Every write is logged twice — here and on the agent — because two
 * records on two machines is what makes it auditable if either is later in question.
 *
 * Bytes are written in hexadecimal rather than as text. A text field would invite pasting a
 * receipt into it, and the difference between "print this" and "execute this" is the difference
 * between a receipt and a printer that needs a power cycle.
 */
export function RawTool({ devices }: { devices: ToolDevice[] }) {
	const [deviceId, setDeviceId] = useState(devices[0]?.id ?? "");
	const [source, setSource] = useState("1B 40\n1B 64 03\n1D 56 00");
	const [pending, startTransition] = useTransition();

	const device = devices.find((entry) => entry.id === deviceId);
	const parsed = parseHex(source);

	if (devices.length === 0) {
		return null;
	}

	return (
		<Card>
			<CardHeader className="flex flex-row flex-wrap items-center gap-3 border-b border-border pb-3">
				<div className="min-w-0 flex-1">
					<h3 className="text-[13px] font-medium">Raw bytes</h3>
					<p className="mt-0.5 text-[11.5px] text-muted-foreground">
						Written to the port unmodified, bypassing the queue. Admin only — no API key can be granted this.
					</p>
				</div>
				<DevicePicker devices={devices} value={deviceId} onChange={setDeviceId} />
			</CardHeader>

			<CardContent className="flex flex-col gap-3 pt-4">
				<div className="flex flex-wrap gap-1.5">
					{SNIPPETS.map((snippet) => (
						<Button
							key={snippet.label}
							type="button"
							variant="outline"
							size="sm"
							className="h-7 text-[11.5px]"
							title={snippet.note}
							onClick={() => setSource((current) => (current.trim() ? `${current}\n${snippet.bytes}` : snippet.bytes))}
						>
							{snippet.label}
						</Button>
					))}
				</div>

				<div className="overflow-hidden rounded-md border border-border">
					<CodeMirror
						value={source}
						height="160px"
						theme={editorTheme}
						basicSetup={{ lineNumbers: true, foldGutter: false, highlightActiveLine: false }}
						onChange={setSource}
					/>
				</div>

				{parsed.error ? (
					<Alert variant="destructive">
						<AlertDescription>{parsed.error}</AlertDescription>
					</Alert>
				) : (
					<p className="text-[11.5px] text-subtle-foreground">
						{parsed.bytes.length} {parsed.bytes.length === 1 ? "byte" : "bytes"}. Hexadecimal, whitespace and{" "}
						<span className="font-mono">#</span> comments ignored.
					</p>
				)}

				<div>
					<Button
						type="button"
						variant="outline"
						className="border-destructive/40 text-destructive hover:bg-destructive/10"
						disabled={pending || parsed.error !== null || parsed.bytes.length === 0 || !device?.online}
						onClick={() =>
							startTransition(async () => {
								const outcome = await writeRaw(deviceId, parsed.bytes);
								if (outcome.error) {
									toast.error(outcome.error);
								} else {
									toast.success(outcome.message ?? "Sent.");
								}
							})
						}
					>
						{pending ? <Spinner className="size-3.5" /> : <Send className="size-3.5" />}
						Write to {device?.label}
					</Button>
					{device && !device.online ? (
						<span className="ml-3 text-[11.5px] text-subtle-foreground">That agent is offline.</span>
					) : null}
				</div>
			</CardContent>
		</Card>
	);
}

/**
 * Reads hexadecimal byte pairs, ignoring whitespace and comments.
 *
 * Refuses anything it does not understand rather than skipping it. A tolerant parser here would
 * silently drop a byte from a control sequence, and a control sequence missing a byte is how a
 * printer ends up in a state nobody can explain.
 *
 * @param source the editor's contents
 * @returns the bytes, or the first thing that was not one
 */
function parseHex(source: string): { bytes: number[]; error: string | null } {
	const bytes: number[] = [];

	for (const rawLine of source.split("\n")) {
		const line = rawLine.split("#")[0].trim();
		if (line === "") {
			continue;
		}
		for (const token of line.split(/[\s,]+/)) {
			if (token === "") {
				continue;
			}
			const cleaned = token.replace(/^0x/i, "");
			if (!/^[0-9a-f]{1,2}$/i.test(cleaned)) {
				return { bytes: [], error: `'${token}' is not a hexadecimal byte.` };
			}
			bytes.push(Number.parseInt(cleaned, 16));
		}
	}

	return { bytes, error: null };
}
