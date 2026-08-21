import type { ReactNode } from "react";
import { CodeBlock } from "@/app/(panel)/docs/code-block";
import { ContentsRail } from "@/app/(panel)/docs/contents-rail";
import { DocSection, type Verb } from "@/app/(panel)/docs/doc-section";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { MAX_ASSET_BYTES, MAX_IMAGE_DIMENSION } from "@/lib/assets/asset-service";
import { MAX_REMOTE_IMAGE_BYTES, REMOTE_FETCH_TIMEOUT_MS } from "@/lib/assets/fetch-remote";
import { prisma } from "@/lib/db";
import { BarcodeSystem } from "@/lib/domain/enums";
import { PERMISSIONS } from "@/lib/domain/permissions";
import { API_ERROR_STATUS } from "@/lib/errors";
import { IMAGE_LIMITS } from "@/lib/link/protocol";
import { MAX_REMOTE_IMAGES } from "@/lib/markup/resolve-images";
import { getPublicAddress } from "@/lib/public-url";

export const metadata = { title: "Docs" };

/** Never cached: the examples name real agents and printers from this install. */
export const dynamic = "force-dynamic";

/**
 * The sections, declared once.
 *
 * The contents rail and the sections themselves both read this, so a heading cannot be renamed
 * into a rail entry that no longer matches it or an anchor that goes nowhere.
 */
const SECTIONS = [
	{
		id: "submitting",
		title: "Submitting a job",
		verbs: ["POST"] as const satisfies readonly Verb[],
		path: "/api/print/{agent}/{device}",
	},
	{ id: "markup", title: "Markup", note: "What a data element may contain" },
	{ id: "blocks", title: "Blocks", note: "Symbols, images and the drawer, and the paper they cost" },
	{ id: "authentication", title: "Authentication", note: "Bearer keys, permissions and device grants" },
	{
		id: "following",
		title: "Following a job",
		verbs: ["GET", "DELETE"] as const satisfies readonly Verb[],
		path: "/api/jobs/{id}",
	},
	{ id: "errors", title: "Errors", note: "Stable codes, and what carries a position" },
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
 * The Docs tab.
 *
 * Written against this install rather than in the abstract: the examples name an agent and a
 * printer that actually exist here, and the address is the one the panel is being served from. A
 * reference someone has to translate into their own setup before trying is one they get wrong
 * the first time.
 *
 * **Laid out for someone whose request is failing right now.** The two facts every call needs —
 * where to send it and what to put in the header — are on screen before any prose; the contents
 * rail exists so "Errors" is one click away rather than a scroll; and each explanation sits
 * beside the call, table or list it describes rather than above it.
 */
export default async function DocsPage() {
	const [address, device] = await Promise.all([
		getPublicAddress(),
		prisma.device.findFirst({
			orderBy: [{ agent: { name: "asc" } }, { name: "asc" }],
			select: { name: true, agent: { select: { name: true } } },
		}),
	]);

	const agentName = device?.agent.name ?? "kitchen-pi";
	const deviceName = device?.name ?? "kitchen";
	const base = address.url;

	return (
		<div className="flex w-full flex-col gap-5">
			{/* Stays on the page rather than joining the description in the top bar, because it is
			    true of this install right now rather than of the section — and it is a caveat about
			    the examples directly below it, which is where a caveat should sit. */}
			{device ? null : (
				<p className="text-[12.5px] text-muted-foreground">
					No printers are configured yet, so the examples below use placeholder names.
				</p>
			)}

			{/* The two things every request needs, before any explanation of them. */}
			<div className="grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-3">
				<Fact label="Base URL" value={base} tint="text-foreground" />
				<Fact label="Every request" value="Authorization: Bearer fpk_…" tint="text-emerald-400" />
				<Fact label="Keys" value="Created on API keys · shown once" tint="text-muted-foreground" />
			</div>

			<div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_150px] xl:items-start">
				<div className="flex min-w-0 flex-col gap-3">
					<DocSection {...SECTIONS[0]}>
						<Split>
							<Col>
								<P>
									Paths are agent-scoped. A device name only has to be unique within its agent, so every site can have
									its own <Mono>kitchen</Mono> without coordinating names across the install.
								</P>

								<P>
									A <Status>202</Status> means the job was compiled, recorded and handed to the agent. It has not
									printed yet — the response carries the job id to follow it with.
								</P>

								<P>
									<Mono>data</Mono> is required and <Mono>linefeed</Mono> (<Mono>LF</Mono>, <Mono>CRLF</Mono>,{" "}
									<Mono>NONE</Mono>) is optional, defaulting to the device's own setting. No other field is accepted.
									Whether a line is broken to the paper width is decided per line, with <Mono>&lt;wrap&gt;</Mono> and{" "}
									<Mono>&lt;nowrap&gt;</Mono>.
								</P>
							</Col>

							<Col>
								<CodeBlock label="Request">{`curl -X POST ${base}/api/print/${agentName}/${deviceName} \\
  -H "Authorization: Bearer fpk_…" \\
  -H "Content-Type: application/json" \\
  -d '{
    "data": [
      "<align=center><bold>THE CORNER CAFE</bold></align>",
      "<hr>",
      "Coffee<fill>2.50",
      "Pastry<fill>3.00",
      "<hr>",
      "<bold>Total<fill>5.50</bold>",
      "<feed=3>",
      "<cut>"
    ]
  }'`}</CodeBlock>

								<CodeBlock label="202 Accepted">{`{ "jobId": "clx…", "status": "QUEUED", "device": "${deviceName}", "lines": 8 }`}</CodeBlock>
							</Col>
						</Split>
					</DocSection>

					<DocSection {...SECTIONS[1]}>
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

					<DocSection {...SECTIONS[2]}>
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
									whose images come to more than one job can hold is refused with <Status>400</Status>{" "}
									<Mono>image_too_large</Mono>.
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
									fails the print with <Status>400</Status> <Mono>invalid_tag_argument</Mono> instead of printing a
									receipt with a hole in it, and a slow one holds the request up. The fetch is guarded — http or https
									only, {seconds(REMOTE_FETCH_TIMEOUT_MS)} for the whole of it including redirects,{" "}
									{megabytes(MAX_REMOTE_IMAGE_BYTES)} of body, and the hostname must resolve to a public address, so a
									receipt cannot use this server to read something inside your network. One request may name at most{" "}
									{MAX_REMOTE_IMAGES} distinct URLs, or <Status>400</Status> <Mono>too_many_remote_images</Mono>; stored
									images are not counted against that.
								</P>

								<P>
									Images are added on the Assets tab, by upload or by importing a URL once, and markup refers to one by
									its slug: the request beside names an image called <Mono>logo</Mono>, and a name that is not stored on
									this install is <Status>404</Status> <Mono>unknown_asset</Mono>. Whichever door a picture comes
									through, it must be a PNG or a JPEG of at most {megabytes(MAX_ASSET_BYTES)} and {MAX_IMAGE_DIMENSION}{" "}
									pixels on each side, and a PNG must not be interlaced.
								</P>

								<P>
									One name is not an asset at all. <Mono>fenpos</Mono> is the application&apos;s own logo, which ships
									with the software rather than being stored here — so it cannot be uploaded under that name, and it
									cannot be deleted out from under the device test page. It is bundled at 384, 504 and 576 dots, which
									is the full width of a 32, 42 or 48 column printer; asking for it at any other width is{" "}
									<Status>400</Status> <Mono>unbundled_logo_width</Mono>, because the logo is never rescaled.
								</P>

								<P>
									<Mono>&lt;drawer&gt;</Mono> is the exception. It pulses a solenoid rather than laying down dots, so it
									costs the paper nothing and may sit beside text — the line that prints the total can open the till.
								</P>

								<P>
									Content is checked when the block closes, and refused with <Status>400</Status>{" "}
									<Mono>invalid_tag_argument</Mono> at the opening tag. The rules beside are format only: a check digit
									that does not add up is refused as well, by the encoder rather than by the rule, so both mistakes come
									back in the response rather than on the paper.
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
									come back <Status>400</Status> <Mono>too_many_output_lines</Mono>. A <Mono>&lt;hr&gt;</Mono> costs the
									one line it prints; <Mono>&lt;cut&gt;</Mono>, <Mono>&lt;feed&gt;</Mono> and{" "}
									<Mono>&lt;drawer&gt;</Mono> cost nothing, since none of them lays dots on the paper as text. The Tools
									tab shows what a job would spend against the limit before it is sent.
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

								<CodeBlock label="Request">{`curl -X POST ${base}/api/print/${agentName}/${deviceName} \\
  -H "Authorization: Bearer fpk_…" \\
  -H "Content-Type: application/json" \\
  -d '{
    "data": [
      "<align=center><image>logo</image></align>",
      "<align=center><qr>https://corner.cafe/r/8f21</qr></align>",
      "<align=center><barcode=EAN13>5901234123457</barcode></align>",
      "<bold>Total<fill>5.50</bold><drawer>",
      "<feed=3>",
      "<cut>"
    ]
  }'`}</CodeBlock>
							</Col>
						</Split>
					</DocSection>

					<DocSection {...SECTIONS[3]}>
						<Split>
							<Col>
								<P>
									Every request carries <Mono>Authorization: Bearer &lt;key&gt;</Mono>. Keys are created on the Keys
									tab, shown once, and stored only as a hash — a lost key is replaced, not recovered.
								</P>

								<P>A key does nothing until it is granted both a permission and at least one printer.</P>

								<P>
									Raw ESC/POS writes are deliberately absent from that list. They hand arbitrary bytes to hardware and
									are reachable only from an admin session on the Tools tab, so no key can be granted them.
								</P>

								<Aside>
									A key addressing a printer it has no grant for gets <Mono>404 unknown_device</Mono> — the same answer
									as a printer that does not exist. That is intentional: distinguishing the two would let a caller
									enumerate every printer in the install by probing names.
								</Aside>
							</Col>

							<div className="min-w-0 divide-y divide-border overflow-hidden rounded-lg border border-border">
								{PERMISSIONS.map((permission) => (
									<div key={permission.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2">
										<span className="rounded border border-border bg-muted/60 px-1.5 py-px font-mono text-[11px] text-foreground">
											{permission.id}
										</span>
										<span className="min-w-0 flex-1 text-[12px] text-muted-foreground">{permission.description}</span>
									</div>
								))}
							</div>
						</Split>
					</DocSection>

					<DocSection {...SECTIONS[4]}>
						<Split>
							<Col>
								<P>
									<Mono>GET</Mono> needs <Mono>jobs:read</Mono> and returns the job's state and timings. A key sees only
									the jobs it submitted itself.
								</P>

								<P>
									<Mono>DELETE</Mono> needs <Mono>jobs:cancel</Mono> and returns <Status>202</Status>. Cancellation is a
									request, not a fact: only the agent knows whether the job is still queued or already halfway through
									the paper, so the final state arrives from it.
								</P>
							</Col>

							<Col>
								<CodeBlock label="Request">{`curl ${base}/api/jobs/clx… -H "Authorization: Bearer fpk_…"`}</CodeBlock>
							</Col>
						</Split>
					</DocSection>

					<DocSection {...SECTIONS[5]}>
						<Split>
							<Col>
								<P>
									Every non-2xx response is <Mono>{`{ "error": "<code>", "message": "…" }`}</Mono>. Branch on{" "}
									<Mono>error</Mono>; the message is for people and may change.
								</P>

								<P>
									A content error also carries <Mono>line</Mono> (1-based index into <Mono>data</Mono>) and, where the
									problem is one character, <Mono>column</Mono>. An unsupported character adds <Mono>character</Mono>{" "}
									and <Mono>codepage</Mono>.
								</P>

								<P>
									Most failures are settled before the response. A job can still fail after its <Status>202</Status> —
									the agent re-checks every dispatch against its own device set and renders it itself — and when one
									does, the reason reaches you the same way as anything else here: a code in <Mono>error</Mono>, with{" "}
									<Mono>errorMessage</Mono> beside it, on the job's own <Mono>GET</Mono>. That is what makes these codes
									worth branching on. An image the agent was never sent is one such reason; see Blocks.
								</P>
							</Col>

							<Col>
								{/* The status is read from the registry rather than written here. It was written here
								    once, and said 422 while the table directly below it — which has always been
								    generated — said 400. An example that contradicts the table beside it is worse than
								    no example. */}
								<CodeBlock label={`${API_ERROR_STATUS.unsupported_character} Unprocessable Content`}>{`{
  "error": "unsupported_character",
  "message": "Character '€' (U+20AC) cannot be printed in codepage CP437",
  "line": 3,
  "column": 18,
  "character": "€",
  "codepage": "CP437"
}`}</CodeBlock>

								<div className="min-w-0 overflow-hidden rounded-lg border border-border">
									<Table>
										<TableHeader>
											<TableRow>
												<TableHead className="w-[90px]">Status</TableHead>
												<TableHead>Codes</TableHead>
											</TableRow>
										</TableHeader>
										<TableBody>
											{groupByStatus().map(([status, codes]) => (
												<TableRow key={status}>
													<TableCell className="align-top">
														<span
															className={`rounded border px-1.5 py-px font-mono text-[11px] font-medium ${statusStyle(status)}`}
														>
															{status}
														</span>
													</TableCell>
													<TableCell>
														{/* Chips rather than a comma-separated line: a reader is matching one code
												    against this list, and a blob of forty makes that a search rather than a look. */}
														<div className="flex flex-wrap gap-1.5">
															{codes.map((code) => (
																<span
																	key={code}
																	className="rounded border border-border bg-muted/50 px-1.5 py-px font-mono text-[11px] text-muted-foreground"
																>
																	{code}
																</span>
															))}
														</div>
													</TableCell>
												</TableRow>
											))}
										</TableBody>
									</Table>
								</div>
							</Col>
						</Split>
					</DocSection>
				</div>

				<ContentsRail sections={SECTIONS} />
			</div>
		</div>
	);
}

/**
 * States a byte limit the way the refusal that enforces it states it.
 *
 * Read from the constant rather than written out, for the same reason the error table is read from
 * `API_ERROR_STATUS`: a documented limit that has to be remembered when the real one changes is a
 * limit this page will eventually be wrong about. Floored to match `requireWithinByteCap`, which is
 * what an operator is actually told when a file is refused.
 *
 * @param bytes the limit
 * @returns it in whole megabytes
 */
function megabytes(bytes: number): string {
	return `${Math.floor(bytes / 1024 / 1024)} MB`;
}

/**
 * States a millisecond budget in the units a person waiting for it would use.
 *
 * @param ms the budget
 * @returns it in seconds
 */
function seconds(ms: number): string {
	return `${ms / 1000} seconds`;
}

/**
 * Groups the error codes by the status they map to.
 *
 * Read from the error module rather than restated, so a code added there appears here without
 * anyone remembering to update the docs — the failure mode that makes documentation untrustworthy.
 */
function groupByStatus(): [number, string[]][] {
	const grouped = new Map<number, string[]>();
	for (const [code, status] of Object.entries(API_ERROR_STATUS)) {
		grouped.set(status, [...(grouped.get(status) ?? []), code]);
	}
	return [...grouped.entries()].sort(([a], [b]) => a - b);
}

/**
 * Colours a status by what the caller should do about it.
 *
 * The same three hues the Jobs tab uses for job state: it worked, you can fix it, the hardware
 * or the server did something. A reader who has seen one screen already knows this vocabulary.
 */
function statusStyle(status: number): string {
	if (status < 300) {
		return "border-emerald-900 bg-emerald-950 text-emerald-400";
	}
	if (status < 500) {
		return "border-amber-900 bg-amber-950 text-amber-400";
	}
	return "border-destructive/40 bg-destructive/10 text-destructive";
}

/**
 * Explanation beside the thing being explained.
 *
 * A reference laid out as one column is either unreadably wide prose or a narrow ribbon of text
 * with an empty half-page beside it. Putting the prose left and the artifact it describes — the
 * call, the tag table, the permission list — on the right spends the width on something worth
 * reading instead of on margin, and keeps the example in view while the paragraph about it is
 * being read. Stacks below `lg`, where there is only room for one column.
 */
function Split({ children }: { children: ReactNode }) {
	return <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] lg:items-start">{children}</div>;
}

/** One side of a {@link Split}. */
function Col({ children }: { children: ReactNode }) {
	return <div className="flex min-w-0 flex-col gap-3">{children}</div>;
}

/** One of the facts every request needs, in the strip above the reference. */
function Fact({ label, value, tint }: { label: string; value: string; tint: string }) {
	return (
		<div className="bg-card px-3 py-2.5">
			<div className="text-[10.5px] font-medium tracking-[0.08em] text-subtle-foreground uppercase">{label}</div>
			<div className={`mt-1 truncate font-mono text-[12px] ${tint}`} title={value}>
				{value}
			</div>
		</div>
	);
}

/**
 * A paragraph of reference prose.
 *
 * Held to about seventy characters. The page used to set prose to the full width of a desktop
 * window, which is roughly a hundred and eighty characters a line — far past the point where the
 * eye reliably finds the start of the next one.
 */
function P({ children }: { children: ReactNode }) {
	return <p className="text-muted-foreground">{children}</p>;
}

/** A point about why the API behaves as it does, rather than what it does. */
function Aside({ children }: { children: ReactNode }) {
	return (
		<div className="rounded-lg border border-border border-l-2 border-l-amber-500/50 bg-amber-950/10 px-3 py-2.5 text-muted-foreground">
			{children}
		</div>
	);
}

function Mono({ children }: { children: ReactNode }) {
	return (
		<code className="rounded border border-border/60 bg-muted px-1 py-0.5 font-mono text-[11.5px] text-foreground/90">
			{children}
		</code>
	);
}

/** An HTTP status referred to inside a sentence. */
function Status({ children }: { children: ReactNode }) {
	return <span className="font-mono text-[11.5px] font-medium text-emerald-400">{children}</span>;
}
