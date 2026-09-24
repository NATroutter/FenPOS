"use client";

import { Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import {
	listMarkupImages,
	listMarkupVariables,
	type MarkupImage,
	type MarkupVariable,
} from "@/app/(panel)/tools/actions";
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
import type { InsertData, SeriesDraft } from "@/lib/markup/editing";
import { applies, fieldsFor, type InsertControl } from "@/lib/markup/insert-fields";

/**
 * The tags whose usefulness depends on something the toolbar cannot guess.
 *
 * The rest of the toolbar writes a tag and gets out of the way, because there is nothing to decide:
 * `<bold>` is `<bold>`. These ten carry a payload or a number that has to come from somewhere, and
 * typing `<barcode type=CODE128></barcode>` by hand means knowing the symbology's name and that it
 * belongs in an attribute rather than the content. That is what this dialog is for.
 *
 * `<image>` is the one that could not be done any other way: an image is referenced by a name stored
 * on the server, so the only alternative to a picker is remembering what the Assets tab calls it. A
 * variable is the same attribute a second time: it too is a name defined elsewhere — on the Variables
 * tab rather than Assets — and it is not even a tag, so there is no markup to learn by heart at all.
 *
 * `chart` and `bar` are here for a different reason: nothing to remember, just a choice (which kind
 * of chart) or a number (how full the gauge is) with no sensible default a button could write on its
 * own. `text` is here because a stored font is a name off the Assets tab, exactly like an image, and
 * asking for it also means asking what it should say — unlike the two built-in fonts, which used to
 * write themselves straight onto the toolbar because there was nothing left to ask.
 *
 * `chart` and `table` ask for more than attributes: both enclose a structure, and a button that
 * writes the structure empty leaves the operator to type `<series>` and `<cell>` by hand, which is
 * the markup the dialog exists to spare them. `box` asks for attributes alone — the lines it frames
 * are the ones already selected — and is here because a frame's width and border had no other way
 * in at all.
 */
export type InsertTag =
	| "image"
	| "variable"
	| "barcode"
	| "qr"
	| "pdf417"
	| "feed"
	| "fill"
	| "chart"
	| "bar"
	| "text"
	| "table"
	| "box";

/** What the dialog asks for, and how it explains itself, per tag. */
const PROMPTS: Record<InsertTag, { title: string; description: string }> = {
	image: {
		title: "Insert an image",
		description:
			"Pick a stored image, or give a URL. Stored images are referenced by name, so the receipt carries the name rather than the picture.",
	},
	variable: {
		title: "Insert a variable",
		description:
			"Pick a value defined on the Variables tab. The receipt carries the name, and the value is filled in when it prints — so changing it later is one edit rather than one per receipt.",
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
	chart: {
		title: "Insert a chart",
		description:
			"Bar, line, pie or scatter, drawn from the series below. Values are separated by commas or spaces; a scatter takes x:y pairs instead, and marks its own axes rather than taking labels.",
	},
	bar: { title: "Insert a gauge", description: "How full the gauge is drawn, 0 (empty) to 100 (full)." },
	text: {
		title: "Insert a font",
		description:
			"A or B for one of the printer's built-in fonts, or the name of a font stored on the Assets tab, drawn at the given size.",
	},
	table: {
		title: "Insert a table",
		description:
			"How many rows and columns, and what each cell holds. Cells may be left empty; a column's width is shared out evenly unless the markup says otherwise.",
	},
	box: {
		title: "Insert a box",
		description:
			"A frame around whole lines. Whatever is selected in the editor is framed; with nothing selected the caret is left inside the box to type into.",
	},
};

/**
 * The tags whose content is the point of writing them.
 *
 * A symbol with nothing to encode is not a symbol, and an `<image>` or a `{name}` with no name
 * refers to nothing. Everything else either carries its meaning in its attributes — a feed, a
 * gauge — or is a paired tag whose text may just as well come from what was selected in the editor.
 */
const NEEDS_CONTENT: ReadonlySet<InsertTag> = new Set(["image", "variable", "barcode", "qr", "pdf417"]);

/**
 * What a required attribute's control opens showing.
 *
 * The registry's own answer rather than a table of preferences: the first value of a fixed set, the
 * lowest of a range. Anything else has no sensible opening value and starts empty, which for a
 * required text attribute is the box waiting to be filled in.
 */
function openingValue(field: InsertControl): [string, string] {
	if (field.kind === "select") {
		return [field.name, field.values[0] ?? ""];
	}
	return [field.name, field.kind === "number" ? String(field.min) : ""];
}

/** A series with nothing in it yet, which is what Add series adds and what a chart dialog opens on. */
const EMPTY_SERIES: SeriesDraft = { values: "", attributes: {} };

/**
 * The grid a table dialog opens on, and the largest one it will collect.
 *
 * Two by two because a table of one cell is a line of text and nobody draws one; the ceiling is
 * about the dialog rather than the parser, which allows a couple of thousand cells: past this, typing
 * into a grid of boxes is slower than copying a `<row>` in the editor and editing it, so the dialog
 * stops pretending to be the better tool.
 */
const GRID_OPENS_AT = 2;
const MOST_ROWS = 20;
const MOST_COLUMNS = 8;

/**
 * The same cells in a grid of a different shape.
 *
 * What was typed is kept wherever it still has a cell to sit in: a column added and taken away again
 * should not cost the rows their text, and a row count nudged past its mark with the stepper's arrow
 * would otherwise clear everything below it.
 */
function resized(cells: readonly (readonly string[])[], rows: number, columns: number): string[][] {
	return Array.from({ length: rows }, (_, row) =>
		Array.from({ length: columns }, (_, column) => cells[row]?.[column] ?? ""),
	);
}

/**
 * Collects the data a tag needs, then hands it back for insertion.
 *
 * Controlled by `tag` rather than by a trigger of its own: the toolbar's Insert menu decides which
 * tag is being written, and a menu item cannot also be a dialog trigger without the menu closing out
 * from under it.
 *
 * @param tag which tag is being inserted, or null when the dialog is closed
 * @param onClose asks the toolbar to clear `tag`
 * @param onInsert receives the tag's attributes and content, both already trimmed
 */
export function InsertDialog({
	tag,
	fonts,
	onClose,
	onInsert,
}: {
	tag: InsertTag | null;
	/** What a `font` attribute may name beyond the printer's own two. */
	fonts: readonly string[];
	onClose: () => void;
	onInsert: (
		tag: InsertTag,
		attributes: Record<string, string> | undefined,
		content: string,
		data?: InsertData,
	) => void;
}) {
	/**
	 * Every attribute's value, by the name markup writes it under, as text.
	 *
	 * One record rather than the scalar per control this used to hold. That pair — one string and one
	 * number — is the whole reason a tag could carry exactly one attribute: `<chart>` collected its
	 * type and had nowhere to put a height. Text even for the numbers, because an empty box and a
	 * zero are different answers and a record of strings says so without a second null-able type.
	 */
	const [values, setValues] = useState<Record<string, string>>({});
	const [content, setContent] = useState("");
	/** A chart's series, in the order they are drawn and named in the legend. */
	const [series, setSeries] = useState<SeriesDraft[]>([EMPTY_SERIES]);
	/** A chart's category labels, as one row of commas — the way `<labels>` itself is written. */
	const [labels, setLabels] = useState("");
	/** A table's cells, row by row. The grid's shape is this array's shape; see {@link resized}. */
	const [cells, setCells] = useState<string[][]>(() => resized([], GRID_OPENS_AT, GRID_OPENS_AT));
	const [images, setImages] = useState<MarkupImage[] | null>(null);
	const [loading, setLoading] = useState(false);
	const [variables, setVariables] = useState<MarkupVariable[] | null>(null);
	const [loadingVariables, setLoadingVariables] = useState(false);

	// Reset per opening, so a dialog never opens showing what was typed into it last time — for
	// `<image>` in particular, a stale name is a receipt that references the wrong picture.
	useEffect(() => {
		if (!tag) {
			return;
		}
		// A required attribute opens with a value, because the tag cannot be written without one and an
		// empty control would only ever be filled in with the same answer. Which value comes from the
		// registry rather than from a list here: the first of a fixed set, the lowest of a range. That
		// reproduces what this used to hardcode — a barcode's first symbology, a chart's `bar`, one
		// line of feed — and keeps doing so for a tag added later.
		setValues(
			Object.fromEntries(
				fieldsFor(tag)
					.filter((field) => field.required)
					.map(openingValue),
			),
		);
		setContent("");
		setSeries([EMPTY_SERIES]);
		setLabels("");
		setCells(resized([], GRID_OPENS_AT, GRID_OPENS_AT));
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

	// Same reasoning as the image library above: fetched once per opening and kept, because a
	// variable's definition changes on the Variables tab, not while this dialog is open.
	useEffect(() => {
		if (tag !== "variable" || variables !== null || loadingVariables) {
			return;
		}
		setLoadingVariables(true);
		listMarkupVariables()
			.then(setVariables)
			.finally(() => setLoadingVariables(false));
	}, [tag, variables, loadingVariables]);

	if (!tag) {
		return null;
	}

	const trimmedContent = content.trim();
	// Only the attributes that mean something beside the answers already given: `<chart>` drops its
	// area fill unless the type is a line, `<text>` drops its size for one of the printer's own faces.
	// Which combinations are legal is the registry's to say and the parser's to enforce — see
	// `applies` — so this dialog cannot offer one the preview would refuse, and an attribute filtered
	// out here is also one `written` no longer carries.
	const fields = fieldsFor(tag).filter((field) => applies(field, values));
	/** Every attribute actually filled in, trimmed; an empty box means the tag simply omits it. */
	const written = Object.fromEntries(
		fields.map((field) => [field.name, (values[field.name] ?? "").trim()]).filter(([, value]) => value !== ""),
	);

	/** A scatter carries its own axes, so it plots pairs and refuses the labels the others take. */
	const scatter = tag === "chart" && (values.type ?? "").toLowerCase() === "scatter";
	/** A pie divides one whole up, so a second series is not something the parser would draw. */
	const single = tag === "chart" && (values.type ?? "").toLowerCase() === "pie";
	const drawn = single ? series.slice(0, 1) : series;

	// Three halves, by now. Every attribute the tag cannot be written without has to be filled in —
	// which the registry says, so no list here repeats it — and the tags whose whole meaning is their
	// content need that content. A `<text>` is the exception among the paired tags for the same reason
	// it always was: its font is the point and its text may be supplied by the selection instead. A
	// chart is the third case: a chart draws what its series hold, so it needs a series holding
	// something, which is the one thing about it nothing else can supply.
	const ready =
		fields.every((field) => !field.required || written[field.name] !== undefined) &&
		(!NEEDS_CONTENT.has(tag) || trimmedContent !== "") &&
		(tag !== "chart" || drawn.some((one) => one.values.trim() !== ""));

	/** The structure this tag encloses, for the two that enclose one. */
	const collected = (): InsertData | undefined => {
		if (tag === "chart") {
			return { kind: "chart", series: drawn, labels: scatter ? "" : labels };
		}
		if (tag === "table") {
			return { kind: "table", rows: cells };
		}
		return undefined;
	};

	const insert = (): void => {
		onInsert(tag, Object.keys(written).length === 0 ? undefined : written, trimmedContent, collected());
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
							<ImageFields images={images} loading={loading} name={content} onName={setContent} />
						) : null}

						{tag === "variable" ? (
							<VariableFields variables={variables} loading={loadingVariables} name={content} onName={setContent} />
						) : null}

						{/* Every attribute the tag declares, drawn from the registry's own spec for it — see
						    `fieldsFor`. What used to stand here was one hand-written block per tag, which is
						    why `<chart>` collected its type and none of its other five. */}
						{fields.map((field) => (
							<AttributeField
								key={field.name}
								field={field}
								fonts={fonts}
								value={values[field.name] ?? ""}
								onValue={(next) => setValues((held) => ({ ...held, [field.name]: next }))}
							/>
						))}

						{tag === "text" ? (
							<Field>
								<FieldLabel htmlFor="insert-text-text">Text</FieldLabel>
								<Textarea
									id="insert-text-text"
									value={content}
									rows={3}
									placeholder="TOTAL"
									onChange={(event) => setContent(event.target.value)}
								/>
								<FieldDescription>
									The text drawn in this font. Left empty, the caret is left between the tags.
								</FieldDescription>
							</Field>
						) : null}

						{tag === "chart" ? (
							<ChartData
								series={drawn}
								labels={labels}
								scatter={scatter}
								single={single}
								chart={values}
								onSeries={setSeries}
								onLabels={setLabels}
							/>
						) : null}

						{tag === "table" ? <TableData cells={cells} onCells={setCells} /> : null}

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
 * One attribute's control, chosen by what the registry says the attribute accepts.
 *
 * The whole dialog's per-tag knowledge used to live in nine hand-written blocks like this one; this
 * is what replaced them. A control here knows about a *kind* of attribute, never about a tag, so
 * `<chart>`'s height and `<qr>`'s module size are the same number box bounded differently, and
 * neither of them is written down twice.
 *
 * The id is built from the attribute's name so that every control has a stable one, which is what
 * the label points at and what carries focus across a republish.
 */
function AttributeField({
	field,
	fonts,
	value,
	onValue,
	idPrefix = "insert-attribute",
}: {
	field: InsertControl;
	fonts: readonly string[];
	value: string;
	onValue: (next: string) => void;
	/** What the control's id begins with, so several series' controls do not share one id. */
	idPrefix?: string;
}) {
	const id = `${idPrefix}-${field.name}`;
	const optional = field.required ? null : <FieldDescription>Optional.</FieldDescription>;

	if (field.kind === "number") {
		return (
			<NumberRow
				label={field.label}
				description={`${field.min} to ${field.max}.${field.required ? "" : " Left empty, the tag omits it."}`}
				value={value === "" ? null : Number.parseInt(value, 10)}
				onChange={(next) => onValue(next === null ? "" : String(next))}
				min={field.min}
				max={field.max}
			/>
		);
	}

	if (field.kind === "select" || field.kind === "font") {
		// A font is a select too, over a list the registry cannot hold: the printer's own two faces,
		// which every install has, followed by whatever this one stores. Typing the name was the thing
		// that made this dialog worth changing.
		const choices = field.kind === "font" ? [...BUILT_IN_FONTS, ...fonts] : field.values;
		return (
			<Field>
				<FieldLabel htmlFor={id}>{field.label}</FieldLabel>
				<Select
					items={Object.fromEntries(choices.map((choice) => [choice, choice]))}
					value={value}
					onValueChange={(next) => next && onValue(String(next))}
				>
					<SelectTrigger id={id}>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{choices.map((choice) => (
							<SelectItem key={choice} value={choice} className="font-mono text-[12px]">
								{choice}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				{field.kind === "font" && fonts.length === 0 ? (
					<FieldDescription>The printer's own faces. Store a font on the Assets tab to add more.</FieldDescription>
				) : (
					optional
				)}
			</Field>
		);
	}

	return (
		<Field>
			<FieldLabel htmlFor={id}>{field.label}</FieldLabel>
			<Input
				id={id}
				value={value}
				maxLength={field.kind === "char" ? 1 : field.maxLength}
				onChange={(event) => onValue(event.target.value)}
			/>
			{field.kind === "char" ? (
				<FieldDescription>One character, repeated. Left empty it is a space.</FieldDescription>
			) : (
				optional
			)}
		</Field>
	);
}

/** The faces every printer has, which no install needs to store. Offered lower-case, as the docs write them. */
const BUILT_IN_FONTS = ["a", "b"] as const;

/**
 * A chart's series and its labels row.
 *
 * What the button used to write was one sample series of `1,2,3` and labels of `a,b,c`, to be found
 * and replaced by hand — which meant the operator still had to know that values go in the content of
 * a `<series>` and its name in an attribute, the very thing a dialog exists to spare them.
 *
 * Each series' attributes are the registry's, filtered as the chart's own are: `marker` is declared
 * to apply to the charts that plot points, so a bar chart's series are not offered one. A pie is the
 * other shape rule — it divides a single whole, so there is no second series to collect — and a
 * scatter carries its own axes, so its points are pairs and there are no categories to label.
 */
function ChartData({
	series,
	labels,
	scatter,
	single,
	chart,
	onSeries,
	onLabels,
}: {
	series: readonly SeriesDraft[];
	labels: string;
	scatter: boolean;
	single: boolean;
	/** The chart's own attributes, which is what a series' conditions are judged against. */
	chart: Readonly<Record<string, string>>;
	onSeries: (next: (held: SeriesDraft[]) => SeriesDraft[]) => void;
	onLabels: (next: string) => void;
}) {
	const controls = fieldsFor("series").filter((field) => applies(field, chart));

	const change = (index: number, edit: (held: SeriesDraft) => SeriesDraft): void =>
		onSeries((held) => held.map((one, at) => (at === index ? edit(one) : one)));

	return (
		<>
			{series.map((one, index) => (
				// Keyed by position, which is what a series is: its place in this list decides the order it
				// is drawn in and the row it takes in the legend, so two series never swap identity.
				// biome-ignore lint/suspicious/noArrayIndexKey: position is the identity here
				<div key={index} className="flex flex-col gap-3 rounded-lg border border-border p-3">
					<div className="flex items-center justify-between">
						<span className="text-[12px] font-medium">{single ? "Series" : `Series ${index + 1}`}</span>
						{series.length > 1 ? (
							<Button
								type="button"
								variant="ghost"
								size="sm"
								className="h-6 px-1.5 text-[11.5px]"
								onClick={() => onSeries((held) => held.filter((_, at) => at !== index))}
							>
								<X className="size-3.5" />
								Remove
							</Button>
						) : null}
					</div>

					<Field>
						<FieldLabel htmlFor={`insert-series-${index}-values`}>Values</FieldLabel>
						<Input
							id={`insert-series-${index}-values`}
							value={one.values}
							className="font-mono text-[12px]"
							placeholder={scatter ? "1:2, 2:3, 3:5" : "1, 2, 3"}
							onChange={(event) => change(index, (held) => ({ ...held, values: event.target.value }))}
						/>
						<FieldDescription>
							{scatter
								? "One x:y pair per point, separated by commas or spaces."
								: "One number per point, separated by commas or spaces."}
						</FieldDescription>
					</Field>

					{controls.map((field) => (
						<AttributeField
							key={field.name}
							field={field}
							fonts={[]}
							idPrefix={`insert-series-${index}`}
							value={one.attributes[field.name] ?? ""}
							onValue={(next) =>
								change(index, (held) => ({ ...held, attributes: { ...held.attributes, [field.name]: next } }))
							}
						/>
					))}
				</div>
			))}

			{single ? (
				<p className="text-[12px] text-muted-foreground">
					A pie divides one whole into shares, so it is drawn from a single series.
				</p>
			) : (
				<Button
					type="button"
					variant="outline"
					size="sm"
					className="h-7 self-start text-[11.5px]"
					onClick={() => onSeries((held) => [...held, EMPTY_SERIES])}
				>
					<Plus className="size-3.5" />
					Add series
				</Button>
			)}

			{scatter ? null : (
				<Field>
					<FieldLabel htmlFor="insert-chart-labels">Labels</FieldLabel>
					<Input
						id="insert-chart-labels"
						value={labels}
						className="font-mono text-[12px]"
						placeholder="Mon, Tue, Wed"
						onChange={(event) => onLabels(event.target.value)}
					/>
					<FieldDescription>
						One label per point, separated by commas. Left empty, the points are drawn unnamed.
					</FieldDescription>
				</Field>
			)}
		</>
	);
}

/**
 * A table's shape and what its cells hold.
 *
 * The shape is two numbers rather than Add row and Add column buttons: a table is a grid, and
 * someone who wants four columns knows that before they start typing into them. Changing either
 * number keeps whatever has already been typed wherever it still fits — see {@link resized} — so a
 * miscounted column is not an afternoon's work to correct.
 */
function TableData({ cells, onCells }: { cells: readonly (readonly string[])[]; onCells: (next: string[][]) => void }) {
	const rows = cells.length;
	const columns = cells[0]?.length ?? 0;

	return (
		<>
			<div className="grid grid-cols-2 gap-4">
				<NumberRow
					label="Rows"
					description={`1 to ${MOST_ROWS}.`}
					value={rows}
					min={1}
					max={MOST_ROWS}
					onChange={(next) => onCells(resized(cells, next ?? 1, columns))}
				/>
				<NumberRow
					label="Columns"
					description={`1 to ${MOST_COLUMNS}.`}
					value={columns}
					min={1}
					max={MOST_COLUMNS}
					onChange={(next) => onCells(resized(cells, rows, next ?? 1))}
				/>
			</div>

			<Field>
				<FieldLabel>Cells</FieldLabel>
				<div className="flex flex-col gap-1 overflow-x-auto rounded-lg border border-border p-2">
					{cells.map((row, rowIndex) => (
						// Keyed by position for the reason a series is: a cell's place in the grid is what it
						// is, and nothing here reorders rows or columns.
						// biome-ignore lint/suspicious/noArrayIndexKey: position is the identity here
						<div key={rowIndex} className="flex gap-1">
							{row.map((cell, columnIndex) => (
								<Input
									// biome-ignore lint/suspicious/noArrayIndexKey: position is the identity here
									key={columnIndex}
									aria-label={`Row ${rowIndex + 1}, column ${columnIndex + 1}`}
									value={cell}
									className="h-7 min-w-24 font-mono text-[12px]"
									onChange={(event) =>
										onCells(
											cells.map((each, at) =>
												at === rowIndex
													? each.map((held, column) => (column === columnIndex ? event.target.value : held))
													: [...each],
											),
										)
									}
								/>
							))}
						</div>
					))}
				</div>
				<FieldDescription>
					What each cell prints. An empty cell is written empty, which draws the column and prints nothing in it.
				</FieldDescription>
			</Field>
		</>
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
}: {
	images: MarkupImage[] | null;
	loading: boolean;
	name: string;
	onName: (next: string) => void;
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
		</>
	);
}

/**
 * The defined variables, picked by name.
 *
 * A picker rather than a free-text field, unlike {@link ImageFields}'s name box: a variable that
 * does not exist is refused when the receipt prints, so there is no equivalent of an image's URL —
 * every legal value here is already one of these rows, and typing a name the Variables tab has never
 * heard of can only produce `unknown_variable` later. Each row shows what it currently resolves to,
 * the same figure the Variables tab's own table shows, so choosing one is choosing a value rather
 * than guessing at a name.
 */
function VariableFields({
	variables,
	loading,
	name,
	onName,
}: {
	variables: MarkupVariable[] | null;
	loading: boolean;
	name: string;
	onName: (next: string) => void;
}) {
	return (
		<>
			{loading ? (
				<div className="flex items-center gap-2 text-[12px] text-muted-foreground">
					<Spinner className="size-3.5" />
					Reading the variables…
				</div>
			) : null}

			{variables && variables.length > 0 ? (
				<Field>
					<FieldLabel>Defined variables</FieldLabel>
					<div className="flex max-h-64 flex-col gap-1 overflow-y-auto rounded-lg border border-border p-2">
						{variables.map((variable) => (
							<button
								key={variable.name}
								type="button"
								onClick={() => onName(variable.name)}
								className={`flex flex-col items-start gap-0.5 rounded-md border p-2 text-left transition-colors hover:bg-muted/40 ${
									name === variable.name ? "border-primary bg-primary/5" : "border-border"
								}`}
							>
								<div className="flex w-full items-center gap-2">
									<span className="font-mono text-[12px]">{`{${variable.name}}`}</span>
									<span className="text-[10.5px] uppercase tracking-wide text-subtle-foreground">{variable.kind}</span>
									<span className="ml-auto truncate font-mono text-[11px] text-muted-foreground">
										{variable.resolves}
									</span>
								</div>
								{variable.description ? (
									<span className="text-[11px] text-muted-foreground">{variable.description}</span>
								) : null}
							</button>
						))}
					</div>
				</Field>
			) : null}

			{variables && variables.length === 0 ? (
				<p className="text-[12px] text-muted-foreground">
					No variables are defined yet. Define one on the Variables tab first.
				</p>
			) : null}
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
 * optional except the feed's, and an empty box is how the markup says "no attribute at all" — which
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
