import { CodeBlock } from "@/app/(panel)/docs/code-block";
import { ContentsRail } from "@/app/(panel)/docs/contents-rail";
import { DocSection } from "@/app/(panel)/docs/doc-section";
import { Aside, Col, DocLink, ErrorRef, Mono, megabytes, P, Split, seconds } from "@/app/(panel)/docs/prose";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { MAX_IMAGE_DIMENSION, maxAssetBytes } from "@/lib/assets/asset-service";
import { BUNDLED_LOGO_WIDTHS } from "@/lib/assets/bundled-logo";
import { MAX_REMOTE_IMAGE_BYTES, REMOTE_FETCH_TIMEOUT_MS } from "@/lib/assets/fetch-remote";
import { BarcodeSystem } from "@/lib/domain/enums";
import { describeBytes } from "@/lib/format/bytes";
import { IMAGE_LIMITS } from "@/lib/link/protocol";
import { MAX_REMOTE_IMAGES } from "@/lib/markup/resolve-images";

export const metadata = { title: "Markup" };

/**
 * The sections, declared once.
 *
 * The contents rail and the sections themselves both read this, so a heading cannot be renamed
 * into a rail entry that no longer matches it or an anchor that goes nowhere.
 */
const SECTIONS = [
	{ id: "markup", title: "Markup", note: "What a data element may contain" },
	{ id: "blocks", title: "Blocks", note: "Symbols, images and the drawer, and the paper they cost" },
] as const;

/** Markup tags, in the order they are worth learning. */
const TAGS: { syntax: string; meaning: string }[] = [
	{ syntax: "<bold>…</bold>", meaning: "Emphasis." },
	{ syntax: "<underline>…</underline>", meaning: "Underline. <underline=2> selects the heavier weight." },
	{ syntax: "<invert>…</invert>", meaning: "White on black." },
	{ syntax: "<size=2>…</size>", meaning: "Character multiplier, 1–8. <size=2,3> sets width and height apart." },
	{ syntax: "<font=b>…</font>", meaning: "The printer's second built-in font, usually narrower." },
	{ syntax: "<align=center>…</align>", meaning: "left, center or right. Must enclose the whole element." },
	{
		syntax: "<wrap>…</wrap>",
		meaning:
			"Break this line at the paper width, whatever the printer's default is. Must enclose the whole element, like <align>.",
	},
	{
		syntax: "<nowrap>…</nowrap>",
		meaning: "Print this line as written. Must enclose the whole element, like <align>.",
	},
	{
		syntax: "<fill>",
		meaning:
			"Pad to the paper's width, so what follows sits at the right margin. <fill=.> repeats a dot instead of a space. Several on one line split the space evenly.",
	},
	{ syntax: "<hr>", meaning: "A rule across the paper. Must be alone in its element." },
	{
		syntax: "<qr>…</qr>",
		meaning: "A QR code. <qr=8> sets the module size, 1–16, default 6. ASCII only. Must be alone in its element.",
	},
	{
		syntax: "<barcode=EAN13>…</barcode>",
		meaning:
			"A linear barcode. UPCA, UPCE, EAN13, EAN8, CODE39, ITF, CODABAR, CODE93 or CODE128, each with its own content rule. Must be alone in its element.",
	},
	{
		syntax: "<pdf417>…</pdf417>",
		meaning:
			"A PDF417 symbol. <pdf417=4> sets the error-correction level, 0–8, default 1. ASCII only. Must be alone in its element.",
	},
	{
		syntax: "<image>name</image>",
		meaning:
			"A stored image, by name, or an http(s) URL. <image=50> sets the printed width as a percentage of the paper, 1–100, default 100. Must be alone in its element.",
	},
	{
		syntax: "<drawer>",
		meaning: "Pulse the cash drawer on pin 2. <drawer=5> uses the other pin. Prints nothing, so it may share a line.",
	},
	{ syntax: "<feed=3>", meaning: "Advance the paper, 1–255 lines." },
	{ syntax: "<cut>", meaning: "Cut the paper. <cut=partial> leaves a tab." },
	{ syntax: "&lt; and &amp;", meaning: "A literal < or &. Any other ampersand is literal text." },
];

/**
 * What each symbology will accept, as `<barcode>` enforces it.
 *
 * Keyed by the symbology set itself, so a symbology added to `BarcodeSystem` fails to compile
 * until it is described here — the alternative being a table that quietly goes one row short. The
 * wording restates `BARCODE_CONTENT_RULES` in `lib/markup/blocks.ts` rather than reading it,
 * because those functions return refusals ("EAN13 requires exactly 13 digits") and a reference
 * reads better stating what is allowed than what is not.
 */
const SYMBOLOGY_CONTENT: Record<BarcodeSystem, string> = {
	UPCA: "Exactly 12 digits.",
	UPCE: "7 or 8 digits, the first of them the 0 that names the number system.",
	EAN13: "Exactly 13 digits.",
	EAN8: "Exactly 8 digits.",
	CODE39: "Digits, A–Z, spaces and -.$/+%",
	ITF: "An even number of digits: it encodes them in pairs.",
	CODABAR: "A, B, C or D at each end, with digits and -$:./+ between.",
	CODE93: "Digits, A–Z, spaces and -.$/+%",
	CODE128: "Any non-empty ASCII text, taken literally.",
};

/**
 * The markup reference.
 *
 * A language rather than an API: what goes inside one field of one endpoint's body. So there is no
 * address here and no key — a receipt template is written by someone who may never make the call
 * that prints it, and the material they need is the tag table and what each tag costs the paper.
 */
export default async function MarkupDocsPage() {
	const assetCap = await maxAssetBytes();

	return (
		<div className="flex w-full flex-col gap-5">
			<div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_150px] xl:items-start">
				<div className="flex min-w-0 flex-col gap-3">
					<DocSection {...SECTIONS[0]}>
						<Split>
							<Col>
								<P>
									Each element of <Mono>data</Mono> is one line before wrapping. Tags are case-insensitive and nest,
									except <Mono>&lt;align&gt;</Mono>, <Mono>&lt;wrap&gt;</Mono>, <Mono>&lt;nowrap&gt;</Mono> and{" "}
									<Mono>&lt;hr&gt;</Mono>, which apply to a whole line and must therefore own it. So do the block tags,
									which additionally admit no tags inside them — see Blocks below.
								</P>

								<P>
									<Mono>&lt;fill&gt;</Mono> is the exception that proves it. Alignment justifies a whole line, so a
									label on the left and an amount on the right cannot be two alignments — <Mono>&lt;fill&gt;</Mono> pads
									the gap between them instead, to whatever the device's width leaves over. It owns nothing, and may
									appear anywhere on a line and as often as you like.
								</P>

								<P>
									Control characters are refused. Markup is the only way to reach printer state, which is what stops a
									request desynchronising the device — a raw <Mono>ESC</Mono> in your text is an error, not a command.
								</P>

								<P>
									Every refusal is like that one: it comes back as a code, with the <Mono>line</Mono> of{" "}
									<Mono>data</Mono> that caused it and, where the problem is one character, the column — so a template
									that will not print says which element to look at rather than that something was wrong somewhere. The
									codes this page names are listed with the rest, and the body they arrive in described, under{" "}
									<DocLink href="/docs/api#errors">Errors</DocLink>.
								</P>

								<P>
									Wrapping counts columns, not characters: under <Mono>&lt;size=2&gt;</Mono> each character costs two,
									so the same text wraps at half the paper width.
								</P>
							</Col>

							<div className="min-w-0 overflow-x-auto rounded-lg border border-border">
								<Table>
									<TableHeader>
										<TableRow>
											<TableHead className="w-[280px]">Tag</TableHead>
											<TableHead>Meaning</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{TAGS.map((tag) => (
											<TableRow key={tag.syntax}>
												<TableCell className="font-mono text-[11.5px] whitespace-nowrap text-sky-300/90">
													{tag.syntax}
												</TableCell>
												<TableCell className="text-[12px] text-muted-foreground">{tag.meaning}</TableCell>
											</TableRow>
										))}
									</TableBody>
								</Table>
							</div>
						</Split>
					</DocSection>

					<DocSection {...SECTIONS[1]}>
						<Split>
							<Col>
								<P>
									<Mono>&lt;qr&gt;</Mono>, <Mono>&lt;barcode&gt;</Mono> and <Mono>&lt;pdf417&gt;</Mono> enclose the
									payload of a symbology — a URL, an article number — rather than text. No tag may appear inside one,
									since styling data changes nothing about the printed symbol, and nothing else may share the element: a
									symbol is a block of dots several lines tall, so anything beside it would overflow the line by
									construction. <Mono>&lt;align&gt;</Mono> still applies, because it justifies the whole line and the
									symbol with it.
								</P>

								<P>
									<Mono>&lt;image&gt;</Mono> is the fourth block, and it names its picture rather than carrying it:
									between the tags goes either the name of an image stored on the Assets tab or an <Mono>http(s)</Mono>{" "}
									URL. Both rules above hold — no tag inside it, nothing else on the element.{" "}
									<Mono>&lt;image=50&gt;</Mono> prints at half the paper's printable width; the argument is a
									percentage, 1–100, defaulting to 100, rather than a number of dots, because one install can have both
									80mm and 58mm printers behind a single agent and a dot count that fits one overruns the other.
								</P>

								<P>
									A stored image is the default and a URL is the escape hatch. Stored images are dithered here, once per
									paper width, and reach the agent with its device configuration — so a receipt printing one at the
									paper's full width carries only its name, however many times it repeats. Any other width has to be
									dithered for that width and carried inside the job, exactly as a URL's dots always are, and a receipt
									whose images come to more than one job can hold is refused with <ErrorRef code="image_too_large" />.
								</P>

								<P>
									What an agent holds is bounded: at most {IMAGE_LIMITS.maxSyncedRasters} rasters, one per stored image
									per distinct paper width behind that agent, taken in name order — and fewer than that when one does
									not fit the configuration frame or is too tall for the protocol to carry, which a handful of large
									images reach long before the count does. An image the agent does not hold, for any of those reasons or
									because it was stored while a job was already in flight, still prints at any width whose dots the job
									carries. At the paper's full width, the one case whose dots do not travel, it fails at the printer
									rather than in the response.
								</P>

								<P>
									A URL is fetched while the job compiles, which is the cost of naming a live image: an unreachable host
									fails the print with <ErrorRef code="invalid_tag_argument" /> instead of printing a receipt with a
									hole in it, and a slow one holds the request up. The fetch is guarded — http or https only,{" "}
									{seconds(REMOTE_FETCH_TIMEOUT_MS)} for the whole of it including redirects,{" "}
									{megabytes(MAX_REMOTE_IMAGE_BYTES)} of body, and the hostname must resolve to a public address, so a
									receipt cannot use this server to read something inside your network. One request may name at most{" "}
									{MAX_REMOTE_IMAGES} distinct URLs, or <ErrorRef code="too_many_remote_images" />; stored images are
									not counted against that.
								</P>

								<P>
									Images are added on the Assets tab, by upload or by importing a URL once, and markup refers to one by
									its slug: the example beside names an image called <Mono>logo</Mono>, and a name that is not stored on
									this install is <ErrorRef code="unknown_asset" />. Whichever door a picture comes through, it must be
									a PNG or a JPEG of at most {describeBytes(assetCap)} and {MAX_IMAGE_DIMENSION} pixels on each side,
									and a PNG must not be interlaced.
								</P>

								<P>
									One name is not an asset at all. <Mono>fenpos</Mono> is the application&apos;s own logo, which ships
									with the software rather than being stored here — so it cannot be uploaded under that name, and it
									cannot be deleted out from under the device test page. It is bundled at{" "}
									{BUNDLED_LOGO_WIDTHS.join(", ")} dots, which is the full width of a 32, 42 or 48 column printer;
									asking for it at any other width is <ErrorRef code="unbundled_logo_width" />, because the logo is
									never rescaled.
								</P>

								<P>
									<Mono>&lt;drawer&gt;</Mono> is the exception. It pulses a solenoid rather than laying down dots, so it
									costs the paper nothing and may sit beside text — the line that prints the total can open the till.
								</P>

								<P>
									Content is checked when the block closes, and refused with <ErrorRef code="invalid_tag_argument" /> at
									the opening tag. The rules beside are format only: a check digit that does not add up is refused as
									well, by the encoder rather than by the rule, so both mistakes come back in the response rather than
									on the paper.
								</P>

								<P>
									QR and PDF417 content must be ASCII, which is a limit of the agent rather than of the symbologies. Its
									printer library declares the symbol's length in characters while writing the string as UTF-8 bytes, so
									one character above <Mono>U+007F</Mono> leaves the printer reading a truncated payload as a perfectly
									valid symbol. A symbol that scans and is wrong is worse than one that fails to print, so it is refused
									here instead.
								</P>

								<P>
									<Mono>CODE128</Mono> takes its content literally. Code 128 has no field for which of its three code
									sets is in use, so the selector travels inside the data as <Mono>{"{A"}</Mono>, <Mono>{"{B"}</Mono> or{" "}
									<Mono>{"{C"}</Mono>; the agent names code set B itself and doubles every brace it was given. A brace
									prints as a brace, and there is no way to switch code set or emit an FNC character. Code set B is an
									ASCII range and nothing wider, so non-ASCII content is refused here rather than by the agent after the
									job has been accepted.
								</P>

								<Aside>
									<Mono>maxOutputLines</Mono> counts paper, not elements. A symbol costs the height it really prints —
									seven lines for a default-size QR code of a short URL, five for any linear barcode — and an image
									costs the lines its dots cover, rounded up to a whole one, which at the paper's full width is the
									picture's own proportions applied to the paper: a square logo on 32-column paper is 384 dots each way,
									or sixteen lines. So a receipt of blocks spends the limit far faster than a receipt of text, and can
									come back <ErrorRef code="too_many_output_lines" />. A <Mono>&lt;hr&gt;</Mono> costs the one line it
									prints; <Mono>&lt;cut&gt;</Mono>, <Mono>&lt;feed&gt;</Mono> and <Mono>&lt;drawer&gt;</Mono> cost
									nothing, since none of them lays dots on the paper as text. The Tools tab shows what a job would spend
									against the limit before it is sent.
								</Aside>
							</Col>

							<Col>
								<div className="min-w-0 overflow-x-auto rounded-lg border border-border">
									<Table>
										<TableHeader>
											<TableRow>
												<TableHead className="w-[110px]">Symbology</TableHead>
												<TableHead>Content</TableHead>
											</TableRow>
										</TableHeader>
										<TableBody>
											{BarcodeSystem.values.map((system) => (
												<TableRow key={system}>
													<TableCell className="font-mono text-[11.5px] whitespace-nowrap text-sky-300/90">
														{system}
													</TableCell>
													<TableCell className="text-[12px] text-muted-foreground">
														{SYMBOLOGY_CONTENT[system]}
													</TableCell>
												</TableRow>
											))}
										</TableBody>
									</Table>
								</div>

								<CodeBlock label="data">{`[
  "<align=center><image>logo</image></align>",
  "<align=center><qr>https://natroutter.fi</qr></align>",
  "<align=center><barcode=EAN13>5901234123457</barcode></align>",
  "<bold>Total<fill>5.50</bold><drawer>",
  "<feed=3>",
  "<cut>"
]`}</CodeBlock>
							</Col>
						</Split>
					</DocSection>
				</div>

				<ContentsRail sections={SECTIONS} />
			</div>
		</div>
	);
}
