"use client";

import CodeMirror from "@uiw/react-codemirror";
import { Printer } from "lucide-react";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { type PreviewLine, type PreviewResult, preview, printMarkup } from "@/app/(panel)/tools/actions";
import type { ToolDevice } from "@/app/(panel)/tools/device-picker";
import { DevicePicker } from "@/app/(panel)/tools/device-picker";
import { editorTheme } from "@/app/(panel)/tools/editor-theme";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";

/** How long the editor sits still before a preview is compiled. */
const DEBOUNCE_MS = 300;

const SAMPLE = `<align=center><bold>KAHVILA</bold></align>
<hr>
Kahvi            2.50
Pulla            3.00
<hr>
<bold>Yhteensa         5.50</bold>
<feed=3>
<cut>`;

/**
 * The markup editor, with a preview of the paper it would produce.
 *
 * **The preview is compiled by the server, through the same pipeline a real request takes.** A
 * preview built from a second implementation in the browser would agree with the real thing right
 * up until it mattered — a codepage rejection, a wrap at an unexpected column — and the entire
 * value of a preview is that what it shows is what will print.
 *
 * That costs a round trip per edit, which is why it is debounced rather than run on every
 * keystroke.
 */
export function MarkupTool({ devices }: { devices: ToolDevice[] }) {
	const [deviceId, setDeviceId] = useState(devices[0]?.id ?? "");
	const [source, setSource] = useState(SAMPLE);
	const [result, setResult] = useState<PreviewResult | null>(null);
	const [compiling, startCompile] = useTransition();
	const [printing, startPrint] = useTransition();

	const device = devices.find((entry) => entry.id === deviceId);

	useEffect(() => {
		if (!deviceId) {
			return;
		}
		const timer = setTimeout(() => {
			startCompile(async () => setResult(await preview(deviceId, source)));
		}, DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [deviceId, source]);

	if (devices.length === 0) {
		return (
			<Card>
				<CardContent className="py-8 text-center text-[12.5px] text-subtle-foreground">
					No printers configured. Add one on the Devices tab to use this.
				</CardContent>
			</Card>
		);
	}

	return (
		<div className="grid gap-4 lg:grid-cols-2 lg:items-start">
			<Card>
				<CardHeader className="flex flex-row flex-wrap items-center gap-3 border-b border-border pb-3">
					<h3 className="flex-1 text-[13px] font-medium">Markup</h3>
					<DevicePicker devices={devices} value={deviceId} onChange={setDeviceId} />
				</CardHeader>
				<CardContent className="flex flex-col gap-3 pt-4">
					<div className="overflow-hidden rounded-md border border-border">
						<CodeMirror
							value={source}
							height="320px"
							theme={editorTheme}
							basicSetup={{ lineNumbers: true, foldGutter: false, highlightActiveLine: false }}
							onChange={setSource}
						/>
					</div>

					<p className="text-[11.5px] text-subtle-foreground">
						One line per element of <span className="font-mono">data</span>. Tags are listed on the Docs tab.
					</p>

					<div>
						<Button
							type="button"
							disabled={printing || !device}
							onClick={() =>
								startPrint(async () => {
									const outcome = await printMarkup(deviceId, source);
									if (outcome.error) {
										toast.error(outcome.error);
									} else {
										toast.success(outcome.message ?? "Queued.");
									}
								})
							}
						>
							{printing ? <Spinner className="size-3.5" /> : <Printer className="size-3.5" />}
							Print on {device?.label}
						</Button>
					</div>
				</CardContent>
			</Card>

			<Card>
				<CardHeader className="flex flex-row items-center gap-3 border-b border-border pb-3">
					<h3 className="flex-1 text-[13px] font-medium">Paper</h3>
					{compiling ? <Spinner className="size-3.5" /> : null}
					{result?.lines ? (
						<span className="font-mono text-[11px] text-subtle-foreground">
							{result.columns} columns · {result.lines.length} lines
						</span>
					) : null}
				</CardHeader>
				<CardContent className="pt-4">
					{result?.error ? (
						<Alert variant="destructive">
							<AlertDescription>
								<span className="font-mono text-[11.5px]">{result.error.code}</span>
								{result.error.line ? (
									<span className="font-mono text-[11.5px]">
										{" "}
										· line {result.error.line}
										{result.error.column ? `, column ${result.error.column}` : ""}
									</span>
								) : null}
								<span className="mt-1 block">{result.error.message}</span>
							</AlertDescription>
						</Alert>
					) : (
						<Paper result={result} />
					)}
				</CardContent>
			</Card>
		</div>
	);
}

/**
 * The compiled lines, drawn at the device's width.
 *
 * Monospace and fixed to the column count, because the whole question a preview answers is where
 * the text lands relative to the paper edge. Directive-only lines are drawn as a marker rather
 * than as blank paper, so a cut is visible where it will happen.
 */
function Paper({ result }: { result: PreviewResult | null }) {
	if (!result?.lines) {
		return <p className="text-[12px] text-subtle-foreground">Type something to see it laid out.</p>;
	}

	return (
		<div
			className="overflow-x-auto rounded-md border border-border bg-white p-3 font-mono text-[12px] leading-[1.45] text-black"
			style={{ width: "fit-content", minWidth: "100%" }}
		>
			{result.lines.length === 0 ? (
				<span className="text-neutral-400">(nothing to print)</span>
			) : (
				result.lines.map((line, index) => (
					<div key={lineKey(index, line)} className="whitespace-pre" style={{ textAlign: align(line.align) }}>
						{line.marker ? (
							<span className="text-neutral-400">{`── ${line.marker} ──`}</span>
						) : line.spans.length === 0 ? (
							" "
						) : (
							line.spans.map((span, spanIndex) => (
								<span
									key={`${index}:${spanIndex}:${span.text}`}
									style={{
										fontWeight: span.bold ? 700 : 400,
										textDecoration: span.underline > 0 ? "underline" : undefined,
										letterSpacing: span.widthMult > 1 ? `${(span.widthMult - 1) * 0.6}em` : undefined,
										backgroundColor: span.invert ? "black" : undefined,
										color: span.invert ? "white" : undefined,
									}}
								>
									{span.text}
								</span>
							))
						)}
					</div>
				))
			)}
		</div>
	);
}

/**
 * Builds a stable key for a printed line.
 *
 * Position alone is not enough — React would reuse a row when the text above it changed length —
 * and printed lines carry no identity of their own, so the key is position plus what is on it.
 */
function lineKey(index: number, line: PreviewLine): string {
	const content = line.marker ?? line.spans.map((span) => span.text).join("");
	return `${index}:${content}`;
}

function align(value: "LEFT" | "CENTER" | "RIGHT"): "left" | "center" | "right" {
	return value === "CENTER" ? "center" : value === "RIGHT" ? "right" : "left";
}
