import { CodeBlock } from "@/app/(panel)/docs/code-block";
import { ContentsRail } from "@/app/(panel)/docs/contents-rail";
import { DocSection, type Verb } from "@/app/(panel)/docs/doc-section";
import {
	Aside,
	Col,
	DocLink,
	ErrorRef,
	groupByStatus,
	Mono,
	P,
	Split,
	Status,
	statusStyle,
} from "@/app/(panel)/docs/prose";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { API_BASE, API_VERSION } from "@/lib/api-version";
import { prisma } from "@/lib/db";
import { PERMISSIONS, type Permission } from "@/lib/domain/permissions";
import { API_ERROR_STATUS } from "@/lib/errors";
import { getPublicAddress } from "@/lib/public-url";

export const metadata = { title: "API" };

/** Never cached: the examples name real agents and printers from this install. */
export const dynamic = "force-dynamic";

/**
 * The sections, declared once.
 *
 * The contents rail and the sections themselves both read this, so a heading cannot be renamed
 * into a rail entry that no longer matches it or an anchor that goes nowhere.
 */
const SECTIONS = [
	{ id: "authentication", title: "Authentication", note: "Bearer keys, permissions and device grants" },
	{
		id: "submitting",
		title: "Submitting a job",
		verbs: ["POST"] as const satisfies readonly Verb[],
		path: `${API_BASE}/print/{agent}/{device}`,
	},
	{
		id: "following",
		title: "Following a job",
		verbs: ["GET", "DELETE"] as const satisfies readonly Verb[],
		path: `${API_BASE}/jobs/{id}`,
	},
	{
		id: "health",
		title: "Health",
		verbs: ["GET"] as const satisfies readonly Verb[],
		path: "/api/health",
	},
	{ id: "errors", title: "Errors", note: "Stable codes, and what carries a position" },
] as const;

/**
 * The permissions an endpoint on this API actually checks.
 *
 * `PERMISSIONS` is the whole vocabulary, and three of its entries — the device and status
 * grants — describe capabilities the panel has but the API does not expose yet. Listing all six
 * without saying so promises an integrator an endpoint to spend them on. Named here rather than
 * derived, because nothing in the code registers "which permissions a route requires"; the test
 * beside this page reads the routes and fails if this list stops matching them.
 */
const ENFORCED: readonly Permission[] = ["print", "jobs:read", "jobs:cancel"];

/**
 * {@link ENFORCED} as a readable list inside a sentence.
 *
 * Rendered from the constant rather than typed into the prose, so the paragraph cannot name a
 * permission the constant above it does not — which is the whole failure this fix is about.
 */
function EnforcedList() {
	return (
		<>
			{ENFORCED.map((permission, index) => (
				<span key={permission}>
					{index > 0 && (index === ENFORCED.length - 1 ? " and " : ", ")}
					<Mono>{permission}</Mono>
				</span>
			))}
		</>
	);
}

/**
 * The Docs tab.
 *
 * Written against this install rather than in the abstract: the examples name an agent and a
 * printer that actually exist here, and the address is the one the panel is being served from. A
 * reference someone has to translate into their own setup before trying is one they get wrong
 * the first time.
 *
 * **Laid out for someone whose request is failing right now.** The opening paragraph carries the
 * address and points at Authentication, so the two facts every call needs are settled before any
 * section is read; the contents rail exists so "Errors" is one click away rather than a scroll;
 * and each explanation sits beside the call, table or list it describes rather than above it.
 */
export default async function ApiDocsPage() {
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

			<P>
				Every path below is relative to <Mono>{base}</Mono>, the address this panel is being served from. Apart from{" "}
				<Mono>/api/health</Mono>, every request carries an API key; Authentication, first below, says where one comes
				from and what it has to be granted before it can do anything.
			</P>

			<P>
				The API is versioned in the path, and this server serves <Mono>{API_VERSION}</Mono> — so the endpoints you call
				live under <Mono>{API_BASE}</Mono>. Pin that prefix rather than deriving it: a future version will sit beside
				this one rather than replacing it, and a request to a path this build does not serve comes back as{" "}
				<ErrorRef code="unknown_endpoint" /> naming the version that is served, in the same envelope as every other
				refusal.
			</P>

			<P>
				<Mono>/api/health</Mono> is deliberately outside that. A container runtime calls it from a healthcheck line
				nobody wants to edit on a version bump, and whether the process is alive is not a contract that evolves.
			</P>

			<div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_150px] xl:items-start">
				<div className="flex min-w-0 flex-col gap-3">
					<DocSection {...SECTIONS[0]}>
						<Split>
							<Col>
								<P>
									Every request carries <Mono>Authorization: Bearer fpk_…</Mono>, where the token is a key created on
									the <Mono>API keys</Mono> tab. A key is shown once, at the moment it is created, and stored here only
									as a hash — so a lost key is replaced rather than recovered, and this panel cannot tell you what an
									existing one is.
								</P>

								<P>A key does nothing until it is granted both a permission and at least one printer.</P>

								<P>
									Only <EnforcedList /> gate an endpoint today. The rest name capabilities this panel has and the API
									does not expose yet, so a key granted one of them has nothing to spend it on — they are listed because
									they are grantable, not because there is a request they unlock.
								</P>

								<P>
									Raw ESC/POS writes are deliberately absent from that list. They hand arbitrary bytes to hardware and
									are reachable only from an admin session on the Tools tab, so no key can be granted them.
								</P>

								<Aside>
									A key addressing a printer it has no grant for gets <ErrorRef code="unknown_device" /> — the same
									answer as a printer that does not exist. That is intentional: distinguishing the two would let a
									caller enumerate every printer in the install by probing names.
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

					<DocSection {...SECTIONS[1]}>
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
								<CodeBlock label="Request">{`curl -X POST ${base}${API_BASE}/print/${agentName}/${deviceName} \\
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

					<DocSection {...SECTIONS[2]}>
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
								<CodeBlock label="Request">{`curl ${base}${API_BASE}/jobs/clx… -H "Authorization: Bearer fpk_…"`}</CodeBlock>
							</Col>
						</Split>
					</DocSection>

					<DocSection {...SECTIONS[3]}>
						<Split>
							<Col>
								<P>
									The one endpoint that takes no key. A healthcheck runs before anyone has signed in, and a probe that
									needed a credential would need one stored somewhere to use it — so this is what a container runtime or
									a load balancer calls, and it is deliberately the only thing they can call.
								</P>

								<P>
									It answers <Status>200</Status> when the process is up and its database answers, and{" "}
									<Status>503</Status> when the database is unreachable. The round trip is the point: a process that has
									started but cannot reach its volume serves HTTP perfectly well while being useless, and reporting that
									as healthy is how a broken deploy gets left running.
								</P>

								<P>
									It reports nothing else, and nothing about the failure. Counts of agents, devices or jobs would turn a
									liveness probe into a way to watch an install from outside it, and the database error's own text is a
									file path or a driver version. Both stay in the server log.
								</P>
							</Col>

							<Col>
								<CodeBlock label="Request">{`curl ${base}/api/health`}</CodeBlock>

								<CodeBlock label="200 OK">{`{ "status": "ok", "database": "ok" }`}</CodeBlock>

								<CodeBlock label="503 Service Unavailable">{`{ "status": "unavailable", "database": "unreachable" }`}</CodeBlock>
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
									The status groups codes by what you have to do about them, and is a summary of the code rather than a
									second contract beside it. A <Status>400</Status> means the request could not be read — the envelope
									is wrong, nothing was interpreted as a receipt, and nothing in that group carries a position because
									there is none to name. A <Status>422</Status> means the request was read and the receipt it describes
									cannot be printed: those are the codes that carry a <Mono>line</Mono>, and you fix the markup rather
									than the request. A <Status>413</Status> means it is well-formed and printable and over a limit, whose
									only remedy is to send less. Branch on <Mono>error</Mono>, not on the status: a code may be
									re-bucketed when the grouping is sharpened, as the content errors were when they moved off{" "}
									<Status>400</Status>.
								</P>

								<P>
									Most failures are settled before the response. A job can still fail after its <Status>202</Status> —
									the agent re-checks every dispatch against its own device set and renders it itself — and when one
									does, the reason reaches you the same way as anything else here: a code in <Mono>error</Mono>, with{" "}
									<Mono>errorMessage</Mono> beside it, on the job's own <Mono>GET</Mono>. That is what makes these codes
									worth branching on. An image the agent was never sent is one such reason; see{" "}
									<DocLink href="/docs/markup#blocks">Blocks</DocLink>.
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
