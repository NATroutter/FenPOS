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
import { API_BASE } from "@/lib/api-version";
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
		id: "job-history",
		title: "Listing jobs",
		verbs: ["GET"] as const satisfies readonly Verb[],
		path: `${API_BASE}/jobs`,
	},
	{ id: "webhooks", title: "Webhooks", note: "Delivery, signature verification and retries for job outcomes" },
	{
		id: "devices",
		title: "Listing devices",
		verbs: ["GET"] as const satisfies readonly Verb[],
		path: `${API_BASE}/devices`,
	},
	{
		id: "device",
		title: "Reading a device",
		verbs: ["GET"] as const satisfies readonly Verb[],
		path: `${API_BASE}/devices/{agent}/{device}`,
	},
	{
		id: "device-actions",
		title: "Acting on a device",
		verbs: ["POST"] as const satisfies readonly Verb[],
		path: `${API_BASE}/devices/{agent}/{device}/actions`,
	},
	{
		id: "status",
		title: "Status",
		verbs: ["GET"] as const satisfies readonly Verb[],
		path: `${API_BASE}/status`,
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
 * `PERMISSIONS` is the whole vocabulary, and every one of its entries gates a request now. The
 * device and status grants used to be the exception — capabilities the panel had and the API did
 * not expose — until the endpoints documented below closed that gap. Named here rather than
 * derived, because nothing in the code registers "which permissions a route requires"; the test
 * beside this page reads the routes and fails if this list stops matching them.
 */
const ENFORCED: readonly Permission[] = [
	"print",
	"jobs:read",
	"jobs:cancel",
	"devices:read",
	"devices:control",
	"status:read",
];

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
		// One grid for the whole page, so the opening card is a column-mate of the sections rather
		// than a band above them. Outside it, the card stretched under the contents rail and its
		// right edge sat 174px past every section below — the kind of misalignment that reads as a
		// mistake even when nobody can say what is wrong.
		<div className="grid w-full gap-6 xl:grid-cols-[minmax(0,1fr)_150px] xl:items-start">
			<div className="flex min-w-0 flex-col gap-3">
				<section className="overflow-hidden rounded-lg border border-border bg-card">
					{/* The two values every call is built from, given the top of the page rather than a
				    clause in the middle of a sentence. They are the only facts here a reader needs
				    before they have read anything: what to put in front of a path, and which version
				    of the API those paths belong to. Everything under them is explanation. */}
					{/* Sized to their contents and packed left, rather than sharing the width out. Stretched
				    across a wide monitor the two values ended up two thousand pixels apart, reading as
				    two lost labels instead of one address you build a call from. */}
					<div className="flex flex-col divide-y divide-border border-b border-border bg-muted/30 sm:flex-row sm:divide-x sm:divide-y-0">
						<div className="min-w-0 px-5 py-3.5">
							<div className="text-[10.5px] font-medium tracking-[0.08em] text-subtle-foreground uppercase">
								Base URL
							</div>
							<div className="mt-1.5 truncate font-mono text-[15px] text-foreground" title={base}>
								{base}
							</div>
						</div>

						<div className="px-5 py-3.5">
							<div className="text-[10.5px] font-medium tracking-[0.08em] text-subtle-foreground uppercase">
								Path prefix
							</div>
							{/* The same sky the markup reference uses for a literal you type, because that is
						    what this is: a path segment to be copied, not a number to be read. */}
							<div className="mt-1.5 font-mono text-[15px] text-sky-300/90">{API_BASE}</div>
						</div>
					</div>

					{/* Held to a readable measure. These paragraphs used to sit outside the page's two-column
				    grid, which is the one place nothing constrained their width — so on a desktop window
				    they ran to about a hundred and eighty characters a line, the exact thing `P` exists
				    to prevent for the prose inside the sections. */}
					<div className="flex max-w-[82ch] flex-col gap-3 px-5 py-4 text-[12.5px] leading-[1.65]">
						<P>
							Every path below is relative to that address. Apart from <Mono>/api/health</Mono>, every request carries
							an API key; Authentication, first below, says where one comes from and what it has to be granted before it
							can do anything.
						</P>

						<P>
							The version is part of the path, so the endpoints you call live under <Mono>{API_BASE}</Mono>. Pin that
							prefix rather than deriving it: a future version will sit beside this one rather than replacing it, and a
							request to a path this build does not serve comes back as <ErrorRef code="unknown_endpoint" /> naming the
							version that is served, in the same envelope as every other refusal.
						</P>

						<P>
							<Mono>/api/health</Mono> is deliberately outside that. A container runtime calls it from a healthcheck
							line nobody wants to edit on a version bump, and whether the process is alive is not a contract that
							evolves.
						</P>

						{/* Sits with the material it qualifies rather than above the page, because it is a
					    caveat about the examples below and true of this install right now. */}
						{device ? null : <P>No printers are configured yet, so the examples below use placeholder names.</P>}
					</div>
				</section>

				<DocSection {...SECTIONS[0]}>
					<Split>
						<Col>
							<P>
								Every request carries <Mono>Authorization: Bearer fpk_…</Mono>, where the token is a key created on the{" "}
								<Mono>API keys</Mono> tab. A key is shown once, at the moment it is created, and stored here only as a
								hash — so a lost key is replaced rather than recovered, and this panel cannot tell you what an existing
								one is.
							</P>

							<P>A key does nothing until it is granted both a permission and at least one printer.</P>

							<P>
								<EnforcedList /> gate an endpoint today — every permission this panel can grant. The device and status
								grants are the newest of them: <Mono>devices:read</Mono> and <Mono>devices:control</Mono> back the
								device endpoints below, and <Mono>status:read</Mono> backs the status endpoint beside them. Whatever a
								key is granted here, there is a request it unlocks.
							</P>

							<P>
								Raw ESC/POS writes are deliberately absent from that list. They hand arbitrary bytes to hardware and are
								reachable only from an admin session on the Tools tab, so no key can be granted them.
							</P>

							<Aside>
								A key addressing a printer it has no grant for gets <ErrorRef code="unknown_device" /> — the same answer
								as a printer that does not exist. That is intentional: distinguishing the two would let a caller
								enumerate every printer in the install by probing names.
							</Aside>

							<P>
								Listing devices, reading one, and status are throttled per key by <Mono>api.readsPerMinute</Mono>, a
								limit an operator sets on the Settings tab. A key over budget gets <ErrorRef code="rate_limited" />
								carrying <Mono>retryAfterSeconds</Mono> in the body — there is no <Mono>Retry-After</Mono> header, so
								the wait lives in the same JSON envelope every other refusal uses rather than a second place to look.
								Submitting a job is deliberately not counted here: a receipt already costs a compile and a device round
								trip, and throttling a till is an operator's decision rather than a default this API makes for them.
							</P>
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
								Paths are agent-scoped. A device name only has to be unique within its agent, so every site can have its
								own <Mono>kitchen</Mono> without coordinating names across the install.
							</P>

							<P>
								A <Status>202</Status> means the job was compiled, recorded and handed to the agent. It has not printed
								yet — the response carries the job id to follow it with.
							</P>

							<P>
								<Mono>data</Mono> is required and <Mono>linefeed</Mono> (<Mono>LF</Mono>, <Mono>CRLF</Mono>,{" "}
								<Mono>NONE</Mono>) is optional, defaulting to the device's own setting. No other field is accepted.
								Whether a line is broken to the paper width is decided per line, with <Mono>&lt;wrap&gt;</Mono> and{" "}
								<Mono>&lt;nowrap&gt;</Mono>.
							</P>

							<P>
								An optional <Mono>Idempotency-Key</Mono> header makes a retry safe. Omit it and nothing here changes.
								Send it, and the first request records the key against the job it creates; a retry presenting the{" "}
								<strong>same</strong> key, the same device and a byte-identical body gets back the original{" "}
								<Status>202</Status> — with an <Mono>Idempotent-Replay: true</Mono> header — and prints nothing a second
								time. The same key with a different body, or the same key and body aimed at a different device, is
								refused as <ErrorRef code="idempotency_conflict" />: reusing a key for two different receipts is a
								caller error, not something to silently paper over.
							</P>

							<Aside>
								This server does not currently sweep the jobs table — <Mono>jobs.retentionMinutes</Mono> and{" "}
								<Mono>jobs.maxRecords</Mono> bound only what is pushed to each agent's own local job store, not the
								history kept here. In practice that means a key is retained forever: it is never freed on its own. Use
								an identifier that is unique for all time — a UUID, not an order number or another value that could
								recur — and never reuse a key across two different receipts.
							</Aside>

							<P>
								Only a request that actually reached <Status>202</Status> <Mono>QUEUED</Mono> is replayable. One that
								failed validation before any job existed, or was accepted and then failed to compile or reach the agent,
								never recorded a key — nothing was queued to record it against, so the key is free and a corrected retry
								is just a new request.
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

							<CodeBlock label="Retry, same Idempotency-Key and body">{`curl -X POST ${base}${API_BASE}/print/${agentName}/${deviceName} \\
  -H "Authorization: Bearer fpk_…" \\
  -H "Idempotency-Key: 5f8a1e2c-4b3d-4a91-9c2e-7d6f0a1b2c3d" \\
  -H "Content-Type: application/json" \\
  -d '{ "data": [ "…same body…" ] }'`}</CodeBlock>

							<CodeBlock label="202 Accepted (replay)">{`Idempotent-Replay: true

{ "jobId": "clx…", "status": "QUEUED", "device": "${deviceName}", "lines": 8 }`}</CodeBlock>

							<CodeBlock label={`${API_ERROR_STATUS.idempotency_conflict} Conflict — different body, same key`}>{`{
  "jobId": "clx…",
  "error": "idempotency_conflict",
  "message": "Idempotency-Key '5f8a1e2c-4b3d-4a91-9c2e-7d6f0a1b2c3d' was already used with a different request body. Use a new key for a different receipt."
}`}</CodeBlock>
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
								request, not a fact: only the agent knows whether the job is still queued or already halfway through the
								paper, so the final state arrives from it.
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
								Needs <Mono>jobs:read</Mono>. The caller's own job history, newest first — what recovers a{" "}
								<Mono>jobId</Mono> a dropped connection lost: a submit that never returned its <Status>202</Status>{" "}
								still left a job behind, and this is how a caller finds it again without ever learning about anyone
								else's.
							</P>

							<P>
								Cursor-paginated with <Mono>limit</Mono> and <Mono>cursor</Mono>. A response carries{" "}
								<Mono>nextCursor</Mono>, which is <Mono>null</Mono> on the last page and otherwise the value to send
								back as <Mono>cursor</Mono> for the next one — never an offset, so a job removed between two requests
								(its device or agent deleted, say) cannot shift the page boundary under a caller still walking it.
							</P>

							<P>
								<Mono>status</Mono>, <Mono>agent</Mono> and <Mono>device</Mono> narrow by name; <Mono>since</Mono> (an
								ISO 8601 timestamp) narrows to jobs submitted at or after it. Every filter composes with the key's own
								scope rather than replacing it — a filter can only narrow what a key already sees, never widen it.
							</P>

							<P>
								Each entry is the same shape <Mono>{`GET ${API_BASE}/jobs/{id}`}</Mono> returns, so a caller has one
								body to parse whether it arrived in a list or on its own.
							</P>
						</Col>

						<Col>
							<CodeBlock label="Request">{`curl "${base}${API_BASE}/jobs?status=FAILED&limit=20" \\
  -H "Authorization: Bearer fpk_…"`}</CodeBlock>

							<CodeBlock label="200 OK">{`{
  "jobs": [
    {
      "jobId": "clx…",
      "status": "FAILED",
      "agent": "${agentName}",
      "device": "${deviceName}",
      "submittedAt": "2026-08-22T18:04:09.000Z",
      "queuedAt": "2026-08-22T18:04:09.100Z",
      "startedAt": "2026-08-22T18:04:09.400Z",
      "finishedAt": "2026-08-22T18:04:09.900Z",
      "lines": 8,
      "bytes": 512,
      "error": "agent_offline",
      "errorMessage": "The agent disconnected mid-print."
    }
  ],
  "nextCursor": null
}`}</CodeBlock>
						</Col>
					</Split>
				</DocSection>

				<DocSection {...SECTIONS[4]}>
					<Split>
						<Col>
							<P>
								A key's job outcomes can be delivered to a URL as they settle, instead of being polled for. There is no
								endpoint here for it: a subscription is registered from the <Mono>Keys</Mono> tab in the panel, by an
								operator with an admin session, never through this API.
							</P>

							<Aside>
								A key that could register its own callback could redirect another integrator's notifications somewhere
								else if it ever leaked — the URL and secret live with the operator who grants the key, not with the key
								itself.
							</Aside>

							<P>
								One delivery is queued for every job that reaches a terminal state — <Mono>COMPLETED</Mono>,{" "}
								<Mono>FAILED</Mono> or <Mono>CANCELLED</Mono> — for a key with an enabled subscription. Exactly one: a
								job reported settled twice, e.g. by an agent reconnecting, still queues a single delivery for it.
							</P>

							<P>
								The payload is a signed <Mono>POST</Mono> of JSON, frozen at the moment the job settled — a retry
								minutes later still describes the job as it was then, not whatever it might read now.
							</P>

							<P>
								Every delivery carries <Mono>X-FenPOS-Signature: t=&lt;unix&gt;,v1=&lt;hex&gt;</Mono>. <Mono>v1</Mono>{" "}
								is an HMAC-SHA256, in hex, of the subscription's secret over the exact string{" "}
								<Mono>
									${"{"}t{"}"}.${"{"}body{"}"}
								</Mono>{" "}
								— the timestamp, a literal dot, then the request body exactly as sent. Verify by recomputing that digest
								with the secret, comparing it to <Mono>v1</Mono> in constant time, and rejecting a <Mono>t</Mono> too
								far from the receiver's own clock. The timestamp is part of the signed material rather than merely sent
								alongside it, deliberately: a delivery captured once cannot be replayed later, because replaying it
								either carries the original, now-stale <Mono>t</Mono> or a fresh one that no longer matches the digest.
							</P>

							<P>
								A <Mono>2xx</Mono> settles the delivery. Anything else is retried with exponential backoff, doubling
								each time, up to <Mono>webhooks.maxAttempts</Mono> — except a <Mono>4xx</Mono> other than{" "}
								<Status>408</Status> or <Status>429</Status>, which is given up on immediately, since a target rejecting
								the shape of a delivery will reject the same bytes again.
							</P>

							<Aside>
								Be idempotent on <Mono>jobId</Mono>. A delivery whose <Mono>2xx</Mono> never made it back to this server
								is retried even though the receiver already acted on it, so the same notification can arrive more than
								once — one settled job queues exactly one delivery, not one guaranteed-once request.
							</Aside>
						</Col>

						<Col>
							<CodeBlock label="POST to the registered URL">{`X-FenPOS-Signature: t=1787421849,v1=5f2b1e…

{
  "event": "job.settled",
  "jobId": "clx…",
  "status": "COMPLETED",
  "agent": "${agentName}",
  "device": "${deviceName}",
  "lines": 8,
  "bytes": 512,
  "error": null,
  "errorMessage": null,
  "at": "2026-08-22T18:04:09.900Z"
}`}</CodeBlock>

							<CodeBlock label="Verifying it (Node.js)">{`import { createHmac, timingSafeEqual } from "node:crypto";

function verifyFenposSignature(secret, body, header, toleranceSeconds = 300) {
  if (typeof header !== "string") return false;

  const match = /^t=(\\d+),v1=([0-9a-f]{64})$/.exec(header.trim());
  if (!match) return false;

  const t = Number(match[1]);
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > toleranceSeconds) return false;

  const expected = Buffer.from(
    createHmac("sha256", secret).update(\`\${t}.\${body}\`, "utf8").digest("hex"),
    "hex",
  );
  const presented = Buffer.from(match[2], "hex");
  return expected.length === presented.length && timingSafeEqual(expected, presented);
}`}</CodeBlock>
						</Col>
					</Split>
				</DocSection>

				<DocSection {...SECTIONS[5]}>
					<Split>
						<Col>
							<P>
								Needs <Mono>devices:read</Mono>. Returns every device this key is granted —{" "}
								<strong>the list is the key's grants, not the install</strong>: a key confined to one site sees that
								site's printers and learns nothing about the rest.
							</P>

							<P>
								Not paginated. The size of this list is something an operator chose when granting devices, so it does
								not grow on its own, and a cursor over a handful of printers would be ceremony for nothing.
							</P>

							<P>
								<Mono>observed</Mono> is <Mono>null</Mono> until the agent has reported at least once since this server
								started; the rest of the body is this server's own configuration and is always present.
							</P>
						</Col>

						<Col>
							<CodeBlock label="Request">{`curl ${base}${API_BASE}/devices -H "Authorization: Bearer fpk_…"`}</CodeBlock>

							<CodeBlock label="200 OK">{`{
  "devices": [
    {
      "agent": "${agentName}",
      "device": "${deviceName}",
      "port": "COM3",
      "columns": 42,
      "codepage": "CP437",
      "defaultLinefeed": "LF",
      "paused": false,
      "maxQueueDepth": null,
      "observed": null
    }
  ]
}`}</CodeBlock>
						</Col>
					</Split>
				</DocSection>

				<DocSection {...SECTIONS[6]}>
					<Split>
						<Col>
							<P>
								Needs <Mono>devices:read</Mono>. One device, in the same shape as an entry in the list above — bare
								rather than wrapped, since the path already names which one.
							</P>

							<P>
								Addressed the same agent-scoped way a print is, so a caller that can print to a device can read it
								without learning a second addressing scheme.
							</P>
						</Col>

						<Col>
							<CodeBlock label="Request">{`curl ${base}${API_BASE}/devices/${agentName}/${deviceName} \\
  -H "Authorization: Bearer fpk_…"`}</CodeBlock>

							<CodeBlock label="200 OK">{`{
  "agent": "${agentName}",
  "device": "${deviceName}",
  "port": "COM3",
  "columns": 42,
  "codepage": "CP437",
  "defaultLinefeed": "LF",
  "paused": false,
  "maxQueueDepth": null,
  "observed": {
    "connection": "CONNECTED",
    "queueDepth": 0,
    "reportedAt": "2026-08-22T18:04:11.000Z"
  }
}`}</CodeBlock>
						</Col>
					</Split>
				</DocSection>

				<DocSection {...SECTIONS[7]}>
					<Split>
						<Col>
							<P>
								Needs <Mono>devices:control</Mono>. The body names one <Mono>action</Mono>: <Mono>connect</Mono>,{" "}
								<Mono>disconnect</Mono>, <Mono>pause</Mono>, <Mono>resume</Mono> or <Mono>clearQueue</Mono>.
							</P>

							<P>
								<Mono>pause</Mono> and <Mono>resume</Mono> also write the stored <Mono>paused</Mono> state, so it
								survives an agent restart. The other three are transient sends: a connection and a queue belong to the
								machine holding the port, and this server has no column that could be right about either.
							</P>

							<P>
								There is no <Mono>test</Mono> action. Printing a diagnostic page is a print, and belongs behind{" "}
								<Mono>print</Mono> — a key granted control of a printer it may not print to must not be able to make it
								print by another name.
							</P>

							<P>
								<Mono>message</Mono> is <Mono>null</Mono> when the agent's reply carries none of its own, which a
								successful action is free to do.
							</P>
						</Col>

						<Col>
							<CodeBlock label="Request">{`curl -X POST ${base}${API_BASE}/devices/${agentName}/${deviceName}/actions \\
  -H "Authorization: Bearer fpk_…" \\
  -H "Content-Type: application/json" \\
  -d '{ "action": "pause" }'`}</CodeBlock>

							<CodeBlock label="200 OK">{`{ "agent": "${agentName}", "device": "${deviceName}", "action": "pause", "message": "Printing paused" }`}</CodeBlock>
						</Col>
					</Split>
				</DocSection>

				<DocSection {...SECTIONS[8]}>
					<Split>
						<Col>
							<P>
								Needs <Mono>status:read</Mono>. Agent liveness and printer readiness, grouped by agent, restricted to
								the agents holding at least one device this key is granted.
							</P>

							<P>
								Distinct from <Mono>/api/health</Mono>: that endpoint stays deliberately contentless because it takes no
								key, and counts of agents or devices there would turn a container probe into a way to watch an install
								from outside it. This endpoint is authenticated and may say more.
							</P>
						</Col>

						<Col>
							<CodeBlock label="Request">{`curl ${base}${API_BASE}/status -H "Authorization: Bearer fpk_…"`}</CodeBlock>

							<CodeBlock label="200 OK">{`{
  "agents": [
    {
      "agent": "${agentName}",
      "status": "ONLINE",
      "lastSeenAt": "2026-08-22T18:04:11.000Z",
      "agentVersion": "1.4.0",
      "devices": [
        {
          "agent": "${agentName}",
          "device": "${deviceName}",
          "port": "COM3",
          "columns": 42,
          "codepage": "CP437",
          "defaultLinefeed": "LF",
          "paused": false,
          "maxQueueDepth": null,
          "observed": {
            "connection": "CONNECTED",
            "queueDepth": 0,
            "reportedAt": "2026-08-22T18:04:11.000Z"
          }
        }
      ]
    }
  ]
}`}</CodeBlock>
						</Col>
					</Split>
				</DocSection>

				<DocSection {...SECTIONS[9]}>
					<Split>
						<Col>
							<P>
								The one endpoint that takes no key. A healthcheck runs before anyone has signed in, and a probe that
								needed a credential would need one stored somewhere to use it — so this is what a container runtime or a
								load balancer calls, and it is deliberately the only thing they can call.
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

				<DocSection {...SECTIONS[10]}>
					<Split>
						<Col>
							<P>
								Every non-2xx response is <Mono>{`{ "error": "<code>", "message": "…" }`}</Mono>. Branch on{" "}
								<Mono>error</Mono>; the message is for people and may change.
							</P>

							<P>
								A content error also carries <Mono>line</Mono> (1-based index into <Mono>data</Mono>) and, where the
								problem is one character, <Mono>column</Mono>. An unsupported character adds <Mono>character</Mono> and{" "}
								<Mono>codepage</Mono>.
							</P>

							<P>
								The status groups codes by what you have to do about them, and is a summary of the code rather than a
								second contract beside it. A <Status>400</Status> means the request could not be read — the envelope is
								wrong, nothing was interpreted as a receipt, and nothing in that group carries a position because there
								is none to name. A <Status>422</Status> means the request was read and the receipt it describes cannot
								be printed: those are the codes that carry a <Mono>line</Mono>, and you fix the markup rather than the
								request. A <Status>413</Status> means it is well-formed and printable and over a limit, whose only
								remedy is to send less. Branch on <Mono>error</Mono>, not on the status: a code may be re-bucketed when
								the grouping is sharpened, as the content errors were when they moved off <Status>400</Status>.
							</P>

							<P>
								Most failures are settled before the response. A job can still fail after its <Status>202</Status> — the
								agent re-checks every dispatch against its own device set and renders it itself — and when one does, the
								reason reaches you the same way as anything else here: a code in <Mono>error</Mono>, with{" "}
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
	);
}
