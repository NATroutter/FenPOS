import { DocSection } from "@/app/(panel)/docs/doc-section";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { prisma } from "@/lib/db";
import { PERMISSIONS } from "@/lib/domain/permissions";
import { API_ERROR_STATUS } from "@/lib/errors";
import { getPublicAddress } from "@/lib/public-url";

export const metadata = { title: "Docs · FenPOS" };

/** Never cached: the examples name real agents and printers from this install. */
export const dynamic = "force-dynamic";

/** Markup tags, in the order they are worth learning. */
const TAGS: { syntax: string; meaning: string }[] = [
	{ syntax: "<bold>…</bold>", meaning: "Emphasis." },
	{ syntax: "<underline>…</underline>", meaning: "Underline. <underline=2> selects the heavier weight." },
	{ syntax: "<invert>…</invert>", meaning: "White on black." },
	{ syntax: "<size=2>…</size>", meaning: "Character multiplier, 1–8. <size=2,3> sets width and height apart." },
	{ syntax: "<font=b>…</font>", meaning: "The printer's second built-in font, usually narrower." },
	{ syntax: "<align=center>…</align>", meaning: "left, center or right. Must enclose the whole element." },
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
		<div className="flex flex-col gap-5">
			<div className="border-b border-border pb-3">
				<h2 className="text-[15px] font-semibold tracking-tight">Docs</h2>
				<p className="mt-1 text-[12.5px] text-muted-foreground">
					The print API, as this install serves it.
					{device ? null : " No printers are configured yet, so the examples use placeholder names."}
				</p>
			</div>

			<DocSection title="Submitting a job" summary={`POST ${base}/api/print/{agent}/{device}`}>
				<p>
					Paths are agent-scoped. A device name only has to be unique within its agent, so every site can have its own{" "}
					<Mono>kitchen</Mono> without coordinating names across the install.
				</p>

				<Code>{`curl -X POST ${base}/api/print/${agentName}/${deviceName} \\
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
  }'`}</Code>

				<p>
					A <Mono>202</Mono> means the job was compiled, recorded and handed to the agent. It has not printed yet — the
					response carries the job id to follow it with.
				</p>

				<Code>{`{ "jobId": "clx…", "status": "QUEUED", "device": "${deviceName}", "lines": 8 }`}</Code>

				<p>
					<Mono>data</Mono> is required. <Mono>wrap</Mono> (boolean) and <Mono>linefeed</Mono> (<Mono>LF</Mono>,{" "}
					<Mono>CRLF</Mono>, <Mono>NONE</Mono>) are optional and default to the device's own settings.
				</p>
			</DocSection>

			<DocSection title="Markup" summary="What a data element may contain">
				<p>
					Each element of <Mono>data</Mono> is one line before wrapping. Tags are case-insensitive and nest, except{" "}
					<Mono>&lt;align&gt;</Mono> and <Mono>&lt;hr&gt;</Mono>, which apply to a whole line and must therefore own it.
				</p>

				<div className="overflow-x-auto rounded-md border border-border">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead className="w-[260px]">Tag</TableHead>
								<TableHead>Meaning</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{TAGS.map((tag) => (
								<TableRow key={tag.syntax}>
									<TableCell className="font-mono text-[11.5px]">{tag.syntax}</TableCell>
									<TableCell className="text-[12px]">{tag.meaning}</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>

				<p>
					Control characters are refused. Markup is the only way to reach printer state, which is what stops a request
					desynchronising the device — a raw <Mono>ESC</Mono> in your text is an error, not a command.
				</p>

				<p>
					Wrapping counts columns, not characters: under <Mono>&lt;size=2&gt;</Mono> each character costs two, so the
					same text wraps at half the paper width.
				</p>
			</DocSection>

			<DocSection title="Authentication" summary="Bearer keys, permissions and device grants">
				<p>
					Every request carries <Mono>Authorization: Bearer &lt;key&gt;</Mono>. Keys are created on the Keys tab, shown
					once, and stored only as a hash — a lost key is replaced, not recovered.
				</p>

				<p>A key does nothing until it is granted both a permission and at least one printer.</p>

				<div className="flex flex-col gap-1.5">
					{PERMISSIONS.map((permission) => (
						<div key={permission.id} className="flex flex-wrap items-baseline gap-2">
							<Badge variant="outline" className="font-mono text-[11px]">
								{permission.id}
							</Badge>
							<span className="text-[12px] text-muted-foreground">{permission.description}</span>
						</div>
					))}
				</div>

				<p>
					Raw ESC/POS writes are deliberately absent from that list. They hand arbitrary bytes to hardware and are
					reachable only from an admin session on the Tools tab, so no key can be granted them.
				</p>

				<p>
					A key addressing a printer it has no grant for gets <Mono>404 unknown_device</Mono> — the same answer as a
					printer that does not exist. That is intentional: distinguishing the two would let a caller enumerate every
					printer in the install by probing names.
				</p>
			</DocSection>

			<DocSection title="Following a job" summary="GET and DELETE /api/jobs/{id}">
				<p>
					<Mono>GET</Mono> needs <Mono>jobs:read</Mono> and returns the job's state and timings. A key sees only the
					jobs it submitted itself.
				</p>

				<Code>{`curl ${base}/api/jobs/clx… -H "Authorization: Bearer fpk_…"`}</Code>

				<p>
					<Mono>DELETE</Mono> needs <Mono>jobs:cancel</Mono> and returns <Mono>202</Mono>. Cancellation is a request,
					not a fact: only the agent knows whether the job is still queued or already halfway through the paper, so the
					final state arrives from it.
				</p>
			</DocSection>

			<DocSection title="Errors" summary="Stable codes, and what carries a position">
				<p>
					Every non-2xx response is <Mono>{`{ "error": "<code>", "message": "…" }`}</Mono>. Branch on <Mono>error</Mono>
					; the message is for people and may change.
				</p>

				<p>
					A content error also carries <Mono>line</Mono> (1-based index into <Mono>data</Mono>) and, where the problem
					is one character, <Mono>column</Mono>. An unsupported character adds <Mono>character</Mono> and{" "}
					<Mono>codepage</Mono>.
				</p>

				<Code>{`{
  "error": "unsupported_character",
  "message": "Character '€' (U+20AC) cannot be printed in codepage CP437",
  "line": 3,
  "column": 18,
  "character": "€",
  "codepage": "CP437"
}`}</Code>

				<div className="overflow-x-auto rounded-md border border-border">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead className="w-[70px]">Status</TableHead>
								<TableHead>Codes</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{groupByStatus().map(([status, codes]) => (
								<TableRow key={status}>
									<TableCell className="font-mono text-[11.5px]">{status}</TableCell>
									<TableCell className="font-mono text-[11px] leading-relaxed">{codes.join(", ")}</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>

				<p>
					Everything is decided before the response. Past a <Mono>202</Mono>, a job can only fail for hardware reasons —
					which is what makes these codes worth branching on.
				</p>
			</DocSection>
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

function Mono({ children }: { children: React.ReactNode }) {
	return <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11.5px]">{children}</code>;
}

function Code({ children }: { children: string }) {
	return (
		<pre className="overflow-x-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-[11.5px] leading-relaxed">
			{children}
		</pre>
	);
}
