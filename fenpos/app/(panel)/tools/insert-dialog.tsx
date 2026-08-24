"use client";

import { useEffect, useState } from "react";
import { listMarkupImages, type MarkupImage } from "@/app/(panel)/tools/actions";
import { DitheredImage } from "@/components/panel/dithered-image";
import {
	NumberField,
	NumberFieldDecrement,
	NumberFieldGroup,
	NumberFieldIncrement,
	NumberFieldInput,
} from "@/components/reui/number-field";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { BarcodeSystem } from "@/lib/domain/enums";

/**
 * The tags whose usefulness depends on something the toolbar cannot guess.
 *
 * The rest of the toolbar writes a tag and gets out of the way, because there is nothing to decide:
 * `<bold>` is `<bold>`. These six carry a payload or a number that has to come from somewhere, and
 * typing `<barcode=CODE128></barcode>` by hand means knowing the symbology's name and that it belongs
 * in the argument rather than the content. That is what this dialog is for.
 *
 * `<image>` is the one that could not be done any other way: an image is referenced by a name stored
 * on the server, so the only alternative to a picker is remembering what the Assets tab calls it.
 */
export type InsertTag = "image" | "barcode" | "qr" | "pdf417" | "feed" | "fill";

/** What the dialog asks for, and how it explains itself, per tag. */
const PROMPTS: Record<InsertTag, { title: string; description: string }> = {
	image: {
		title: "Insert an image",
		description:
			"Pick a stored image, or give a URL. Stored images are referenced by name, so the receipt carries the name rather than the picture.",
	},
	barcode: {
		title: "Insert a barcode",
		description:
			"The symbology decides what the content may contain — EAN13 wants 12 or 13 digits, CODE128 takes text. A payload the symbology cannot carry is refused when the receipt is compiled, not here.",
	},
	qr: {
		title: "Insert a QR code",
		description: "The module size is how many dots wide each square is. Larger is easier to scan and takes more paper.",
	},
	pdf417: {
		title: "Insert a PDF417 symbol",
		description: "The error-correction level trades paper for damage tolerance. Left empty, the encoder picks one.",
	},
	feed: { title: "Advance the paper", description: "Blank lines to feed, before whatever comes next." },
	fill: {
		title: "Insert a fill",
		description:
			"Pads the line out to the paper's width — the space between a name on the left and a price on the right. The character is repeated to fill the gap.",
	},
};

/**
 * Collects the data a tag needs, then hands it back for insertion.
 *
 * Controlled by `tag` rather than by a trigger of its own: the toolbar's Insert menu decides which
 * tag is being written, and a menu item cannot also be a dialog trigger without the menu closing out
 * from under it.
 *
 * @param tag which tag is being inserted, or null when the dialog is closed
 * @param onClose asks the toolbar to clear `tag`
 * @param onInsert receives the tag's argument and content, both already trimmed
 */
export function InsertDialog({
	tag,
	onClose,
	onInsert,
}: {
	tag: InsertTag | null;
	onClose: () => void;
	onInsert: (tag: InsertTag, argument: string | undefined, content: string) => void;
}) {
	const [argument, setArgument] = useState("");
	/**
	 * The argument of the tags whose argument is a number.
	 *
	 * Held apart from {@link argument} rather than as text, because these use the same stepper the
	 * Settings tab does and that speaks in numbers. `null` is a real state and not zero: it is the
	 * empty box, which is how the markup says "no argument at all" — a different thing from any value
	 * the field could hold.
	 */
	const [amount, setAmount] = useState<number | null>(null);
	const [content, setContent] = useState("");
	const [images, setImages] = useState<MarkupImage[] | null>(null);
	const [loading, setLoading] = useState(false);

	// Reset per opening, so a dialog never opens showing what was typed into it last time — for
	// `<image>` in particular, a stale name is a receipt that references the wrong picture.
	useEffect(() => {
		if (!tag) {
			return;
		}
		setArgument(tag === "barcode" ? "CODE128" : "");
		// Only the feed starts with a value: it is the one whose argument is required, and one line
		// is what someone reaching for it usually wants.
		setAmount(tag === "feed" ? 1 : null);
		setContent("");
	}, [tag]);

	// The library is fetched on the first opening of the image dialog and kept: images change on
	// another tab, not while someone is composing a receipt on this one.
	useEffect(() => {
		if (tag !== "image" || images !== null || loading) {
			return;
		}
		setLoading(true);
		listMarkupImages()
			.then(setImages)
			.finally(() => setLoading(false));
	}, [tag, images, loading]);

	if (!tag) {
		return null;
	}

	const trimmedContent = content.trim();
	const trimmedArgument = argument.trim();
	/** Whether this tag's argument is the numeric one. */
	const numeric = tag === "image" || tag === "qr" || tag === "pdf417" || tag === "feed";
	// The void tags carry everything in their argument and enclose nothing; the rest need content.
	const ready = tag === "feed" ? amount !== null : tag === "fill" ? true : trimmedContent !== "";

	const insert = (): void => {
		const written = numeric ? (amount === null ? "" : String(amount)) : trimmedArgument;
		onInsert(tag, written === "" ? undefined : written, trimmedContent);
		onClose();
	};

	return (
		<Dialog
			open
			onOpenChange={(next) => {
				if (!next) {
					onClose();
				}
			}}
		>
			<DialogContent className="sm:max-w-[560px]">
				<DialogHeader>
					<DialogTitle>{PROMPTS[tag].title}</DialogTitle>
					<DialogDescription>{PROMPTS[tag].description}</DialogDescription>
				</DialogHeader>
				<DialogBody>
					<div className="flex flex-col gap-4">
						{tag === "image" ? (
							<ImageFields
								images={images}
								loading={loading}
								name={content}
								onName={setContent}
								width={amount}
								onWidth={setAmount}
							/>
						) : null}

						{tag === "barcode" ? (
							<Field>
								<FieldLabel htmlFor="insert-barcode-system">Symbology</FieldLabel>
								<Select
									items={Object.fromEntries(BarcodeSystem.values.map((value) => [value, value]))}
									value={trimmedArgument}
									onValueChange={(next) => next && setArgument(String(next))}
								>
									<SelectTrigger id="insert-barcode-system">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{BarcodeSystem.values.map((value) => (
											<SelectItem key={value} value={value} className="font-mono text-[12px]">
												{value}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</Field>
						) : null}

						{tag === "qr" ? (
							<NumberRow
								label="Module size"
								description="1 to 16. Left empty, the printer's default is used."
								value={amount}
								onChange={setAmount}
								min={1}
								max={16}
							/>
						) : null}

						{tag === "pdf417" ? (
							<NumberRow
								label="Error correction"
								description="0 to 8. Left empty, the encoder chooses."
								value={amount}
								onChange={setAmount}
								min={0}
								max={8}
							/>
						) : null}

						{tag === "feed" ? (
							<NumberRow
								label="Lines"
								description="How many blank lines to advance."
								value={amount}
								onChange={setAmount}
								min={1}
								max={255}
							/>
						) : null}

						{tag === "fill" ? (
							<Field>
								<FieldLabel htmlFor="insert-fill-character">Character</FieldLabel>
								<Input
									id="insert-fill-character"
									value={argument}
									maxLength={1}
									placeholder="."
									onChange={(event) => setArgument(event.target.value)}
								/>
								<FieldDescription>
									One character, repeated. Left empty it is a space, which is what most receipts want.
								</FieldDescription>
							</Field>
						) : null}

						{tag === "barcode" || tag === "qr" || tag === "pdf417" ? (
							<Field>
								<FieldLabel htmlFor="insert-symbol-content">Content</FieldLabel>
								<Textarea
									id="insert-symbol-content"
									value={content}
									rows={3}
									placeholder={tag === "barcode" ? "5901234123457" : "https://example.com/order/1234"}
									onChange={(event) => setContent(event.target.value)}
								/>
								<FieldDescription>What the symbol encodes. It is not printed as text.</FieldDescription>
							</Field>
						) : null}
					</div>
				</DialogBody>
				<DialogFooter>
					<Button type="button" variant="outline" onClick={onClose}>
						Cancel
					</Button>
					<Button type="button" disabled={!ready} onClick={insert}>
						Insert
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/**
 * The stored image library, plus the two things that are not a stored image.
 *
 * A picker and a free-text field rather than one or the other: most of the time the image wanted is
 * one of a handful already on the Assets tab, and clicking it is faster than remembering its name.
 * But `<image>` also takes a URL, and an operator who has just uploaded something on another tab
 * should not have to reload this one to reference it — so the field stays editable, and the grid
 * fills it in.
 */
function ImageFields({
	images,
	loading,
	name,
	onName,
	width,
	onWidth,
}: {
	images: MarkupImage[] | null;
	loading: boolean;
	name: string;
	onName: (next: string) => void;
	width: number | null;
	onWidth: (next: number | null) => void;
}) {
	return (
		<>
			{loading ? (
				<div className="flex items-center gap-2 text-[12px] text-muted-foreground">
					<Spinner className="size-3.5" />
					Reading the image library…
				</div>
			) : null}

			{images && images.length > 0 ? (
				<Field>
					<FieldLabel>Stored images</FieldLabel>
					<div className="grid max-h-64 grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-2 overflow-y-auto rounded-lg border border-border p-2">
						{images.map((image) => (
							<button
								key={image.name}
								type="button"
								onClick={() => onName(image.name)}
								className={`flex flex-col items-center gap-1.5 rounded-md border p-2 transition-colors hover:bg-muted/40 ${
									name === image.name ? "border-primary bg-primary/5" : "border-border"
								}`}
							>
								{image.preview ? (
									<DitheredImage src={image.preview} alt={image.name} className="max-h-20 w-full object-contain" />
								) : (
									<span className="flex h-20 items-center text-[11px] text-subtle-foreground">No preview</span>
								)}
								<span className="w-full truncate text-center font-mono text-[11px]">{image.name}</span>
							</button>
						))}
					</div>
				</Field>
			) : null}

			{images && images.length === 0 ? (
				<p className="text-[12px] text-muted-foreground">
					No images are stored yet. Add one on the Assets tab, or give a URL below.
				</p>
			) : null}

			<Field>
				<FieldLabel htmlFor="insert-image-name">Name or URL</FieldLabel>
				<Input
					id="insert-image-name"
					value={name}
					placeholder="logo"
					onChange={(event) => onName(event.target.value)}
				/>
				<FieldDescription>A stored image's name, or an http(s) URL the server can reach.</FieldDescription>
			</Field>

			<NumberRow
				label="Width"
				description="A percentage of the paper's width, 1 to 100. Left empty, the image prints at its own size."
				value={width}
				onChange={onWidth}
				min={1}
				max={100}
			/>
		</>
	);
}

/**
 * A bounded whole number, in the stepper the Settings tab uses for the same job.
 *
 * The same control rather than a plain text box, so a number means the same thing and behaves the
 * same way wherever the panel asks for one: the bounds are enforced by the field instead of stated
 * in prose beside it, and the arrows are there for the values people nudge rather than type.
 *
 * Empty is a value here in a way it is not in Settings: every number this dialog collects is
 * optional except the feed's, and an empty box is how the markup says "no argument at all" — which
 * is why `null` is passed straight through rather than being turned into a zero.
 */
function NumberRow({
	label,
	description,
	value,
	onChange,
	min,
	max,
}: {
	label: string;
	description: string;
	value: number | null;
	onChange: (next: number | null) => void;
	min: number;
	max: number;
}) {
	return (
		<Field>
			<FieldLabel>{label}</FieldLabel>
			<NumberField value={value} min={min} max={max} onValueChange={onChange}>
				<NumberFieldGroup>
					<NumberFieldDecrement />
					<NumberFieldInput className="font-mono" />
					<NumberFieldIncrement />
				</NumberFieldGroup>
			</NumberField>
			<FieldDescription>{description}</FieldDescription>
		</Field>
	);
}
