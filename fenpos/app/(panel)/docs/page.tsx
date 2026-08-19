import type { ReactNode } from "react";
import { CodeBlock } from "@/app/(panel)/docs/code-block";
import { DocSection, type Verb } from "@/app/(panel)/docs/doc-section";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { prisma } from "@/lib/db";
import { PERMISSIONS } from "@/lib/domain/permissions";
import { API_ERROR_STATUS } from "@/lib/errors";
import { getPublicAddress } from "@/lib/public-url";

export const metadata = { title: "Docs · FenPOS" };

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
	{ syntax: "<wrap>…</wrap>", meaning: "Break this line at the paper width, whatever the printer's default is." },
	{
		syntax: "<nowrap>…</nowrap>",
		meaning: "Print this line as written. Must enclose the whole element, like <align>.",
	},
	{ syntax: "<hr>", meaning: "A rule across the paper. Must be alone in its element." },
	{ syntax: "<feed=3>", meaning: "Advance the paper, 1–255 lines." },
	{ syntax: "<cut>", meaning: "Cut the paper. <cut=partial> leaves a tab." },
	{ syntax: "&lt; and &amp;", meaning: "A literal < or &. Any other ampersand is literal text." },
];

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
			<div className="border-b border-border pb-3">
				<h2 className="text-[15px] font-semibold tracking-tight">Docs</h2>
				<p className="mt-1 text-[12.5px] text-muted-foreground">
					The print API, as this install serves it.
					{device ? null : " No printers are configured yet, so the examples use placeholder names."}
				</p>
			</div>

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
      "<align=center><bold>KAHVILA</bold></align>",
      "<hr>",
      "Kahvi            2.50",
      "Pulla            3.00",
      "<hr>",
      "<bold>Yhteensa         5.50</bold>",
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
									except <Mono>&lt;align&gt;</Mono> and <Mono>&lt;hr&gt;</Mono>, which apply to a whole line and must
									therefore own it.
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

					<DocSection {...SECTIONS[3]}>
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

					<DocSection {...SECTIONS[4]}>
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
									Everything is decided before the response. Past a <Status>202</Status>, a job can only fail for
									hardware reasons — which is what makes these codes worth branching on.
								</P>
							</Col>

							<Col>
								<CodeBlock label="422 Unprocessable">{`{
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

				<nav aria-label="On this page" className="hidden xl:sticky xl:top-2 xl:block">
					<div className="text-[10.5px] font-medium tracking-[0.08em] text-subtle-foreground uppercase">
						On this page
					</div>
					<ul className="mt-2 flex flex-col gap-px border-l border-border">
						{SECTIONS.map((section) => (
							<li key={section.id}>
								<a
									href={`#${section.id}`}
									className="-ml-px block border-l border-transparent py-1 pl-3 text-[12px] text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground"
								>
									{section.title}
								</a>
							</li>
						))}
					</ul>
				</nav>
			</div>
		</div>
	);
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
