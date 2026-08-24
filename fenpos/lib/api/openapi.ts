import { API_DEVICE_ACTIONS } from "@/lib/api/device-actions";
import { API_BASE, API_VERSION } from "@/lib/api-version";
import { AgentStatus, Align, AssetKind, ConnectionStatus, JobStatus, Linefeed } from "@/lib/domain/enums";
import { PERMISSION_IDS } from "@/lib/domain/permissions";
import { API_ERROR_STATUS } from "@/lib/errors";

/**
 * A machine-readable description of the public API, served at `GET /api/v1/openapi.json`.
 *
 * Hand-maintained rather than generated. There is no schema-first source to generate this from —
 * request shapes are Zod schemas scattered across the compiler and the individual routes, and a
 * generator bolted onto them would describe the plumbing rather than the contract an integrator
 * actually reads. `test/lib/api/openapi.test.ts` is what keeps a hand-written document honest: it
 * walks the route tree the same way `docs-check.test.ts` walks it for the prose pages, and a route
 * added without a matching `paths` entry fails the suite. What an entry *says* is still a human's
 * job; that it exists at all is not.
 *
 * Every enumerated value below is read from the constant that already defines it — `ConnectionStatus`,
 * `JobStatus`, `AgentStatus`, `Align`, `Linefeed`, `AssetKind`, `API_DEVICE_ACTIONS`, `PERMISSION_IDS`,
 * `API_ERROR_STATUS` — rather than typed out by hand a second time. `DeviceView.observed.connection` in
 * `lib/api/device-view.ts` is itself declared as a loose `string`, so nothing at the type level would
 * catch this document drifting from the domain's real `ConnectionStatus` union; deriving from the
 * source of truth is the only thing that does.
 */

/** One security requirement: any bearer key, whatever it is granted. */
const BEARER_AUTH = [{ bearerAuth: [] }];

/** No security requirement: this document itself needs no credential to read. */
const NO_AUTH: unknown[] = [];

/** Every non-2xx response, whatever the status, shares this envelope — see `components.schemas.Error`. */
const ERROR_RESPONSE = {
	description:
		"The request did not succeed. `error` is the stable field to branch on; `message` is for people and is not part of the contract. The status this carries is a summary of `error`, grouped by what the caller must do about it — see the panel's own `/docs/api#errors` for the full table.",
	content: {
		"application/json": {
			schema: { $ref: "#/components/schemas/Error" },
		},
	},
};

/**
 * A JSON response body for one status code.
 *
 * @param description what the status means for this operation
 * @param schema the response body's shape
 * @returns an OpenAPI response object
 */
function jsonResponse(description: string, schema: object): object {
	return { description, content: { "application/json": { schema } } };
}

/** A response carrying no body. */
function emptyResponse(description: string): object {
	return { description };
}

/** The device shape every endpoint that mentions a printer returns — see `lib/api/device-view.ts`. */
const DEVICE_SCHEMA = {
	type: "object",
	properties: {
		agent: { type: "string", description: "The agent's name, as it appears in a print path." },
		device: { type: "string", description: "The device's name, unique within the agent, not globally." },
		port: { type: "string" },
		columns: { type: "integer", description: "Printable columns. Needed to compose fixed-width markup." },
		codepage: { type: "string" },
		defaultLinefeed: { type: "string", enum: Linefeed.values },
		paused: { type: "boolean", description: "Desired state, held by this server. Survives an agent restart." },
		maxQueueDepth: {
			type: ["integer", "null"],
			description: "Configured queue ceiling, or null when the device inherits the install-wide one.",
		},
		observed: {
			type: ["object", "null"],
			description: "What the agent last reported, or null when it has reported nothing since this server started.",
			properties: {
				connection: { type: "string", enum: ConnectionStatus.values },
				queueDepth: { type: "integer" },
				reportedAt: { type: "string", format: "date-time" },
			},
			required: ["connection", "queueDepth", "reportedAt"],
		},
	},
	required: [
		"agent",
		"device",
		"port",
		"columns",
		"codepage",
		"defaultLinefeed",
		"paused",
		"maxQueueDepth",
		"observed",
	],
};

/** The job shape both `GET /jobs/{id}` and each entry of `GET /jobs` return. */
const JOB_SCHEMA = {
	type: "object",
	properties: {
		jobId: { type: "string" },
		status: { type: "string", enum: JobStatus.values },
		agent: { type: "string" },
		device: { type: "string" },
		submittedAt: { type: "string", format: "date-time" },
		queuedAt: { type: ["string", "null"], format: "date-time" },
		startedAt: { type: ["string", "null"], format: "date-time" },
		finishedAt: { type: ["string", "null"], format: "date-time" },
		lines: { type: ["integer", "null"] },
		bytes: { type: ["integer", "null"] },
		error: {
			type: ["string", "null"],
			description: "The code the job failed with, in the same vocabulary as the Error schema, or null.",
		},
		errorMessage: { type: ["string", "null"] },
	},
	required: [
		"jobId",
		"status",
		"agent",
		"device",
		"submittedAt",
		"queuedAt",
		"startedAt",
		"finishedAt",
		"lines",
		"bytes",
		"error",
		"errorMessage",
	],
};

/** One stored image, without its bytes — what `GET /assets` lists. */
const ASSET_SUMMARY_SCHEMA = {
	type: "object",
	properties: {
		name: { type: "string" },
		kind: { type: "string", enum: AssetKind.values },
		width: { type: "integer" },
		height: { type: "integer" },
		mimeType: { type: "string" },
		sourceUrl: { type: ["string", "null"], description: "The URL it was imported from, or null for an upload." },
		createdAt: { type: "string", format: "date-time" },
	},
	required: ["name", "kind", "width", "height", "mimeType", "sourceUrl", "createdAt"],
};

/** One compiled line, as `POST /preview` reports it — see `CompiledLine` in `lib/jobs/preview.ts`. */
const COMPILED_LINE_SCHEMA = {
	type: "object",
	properties: {
		align: { type: "string", enum: Align.values },
		spans: {
			type: "array",
			items: {
				type: "object",
				properties: {
					text: { type: "string" },
					bold: { type: "boolean" },
					underline: { type: "integer", description: "0 for none, 1 or 2 for the two ESC/POS weights." },
					invert: { type: "boolean" },
					widthMult: { type: "integer" },
				},
				required: ["text", "bold", "underline", "invert", "widthMult"],
			},
		},
	},
	required: ["align", "spans"],
};

/** One thing wrong with a previewed receipt — see `PreviewFault` in `lib/jobs/preview.ts`. */
const PREVIEW_FAULT_SCHEMA = {
	type: "object",
	properties: {
		code: { type: "string", description: "One of the codes `components.schemas.Error` documents." },
		message: { type: "string" },
		status: { type: "integer", description: "The status the print endpoint would answer this with." },
		line: { type: ["integer", "null"], description: "1-based element, or null for a request-level failure." },
		column: { type: ["integer", "null"] },
	},
	required: ["code", "message", "status", "line", "column"],
};

/** What `POST /preview/{agent}/{device}` returns: always `200`, whether or not the receipt compiled. */
const PREVIEW_SCHEMA = {
	type: "object",
	properties: {
		agent: { type: "string" },
		device: { type: "string" },
		columns: { type: "integer" },
		outputLines: { type: "integer" },
		maxOutputLines: { type: "integer" },
		linefeed: { type: "string", enum: Linefeed.values },
		lines: {
			type: ["array", "null"],
			description: "Null when the receipt did not compile.",
			items: COMPILED_LINE_SCHEMA,
		},
		errors: { type: "array", description: "Empty when the receipt compiled.", items: PREVIEW_FAULT_SCHEMA },
	},
	required: ["agent", "device", "columns", "outputLines", "maxOutputLines", "linefeed", "lines", "errors"],
};

/** The body `POST /print/{agent}/{device}` and `POST /preview/{agent}/{device}` both accept. */
const PRINT_REQUEST_SCHEMA = {
	type: "object",
	properties: {
		data: { type: "array", items: { type: "string" }, description: "The receipt, one markup element per line." },
		linefeed: {
			type: "string",
			enum: Linefeed.values,
			description: "Overrides the device's own default for this job only.",
		},
	},
	required: ["data"],
};

/** The `limit` and `cursor` query parameters every cursor-paginated listing shares. */
const PAGE_PARAMS = [
	{
		name: "limit",
		in: "query",
		required: false,
		schema: { type: "integer", minimum: 1 },
		description: "Clamped to the install's configured ceiling rather than refused when it is exceeded.",
	},
	{
		name: "cursor",
		in: "query",
		required: false,
		schema: { type: "string" },
		description: "The `nextCursor` from a previous page. Omit for the first page.",
	},
];

/** The `{ nextCursor }` field every cursor-paginated listing's response carries. */
const NEXT_CURSOR_PROPERTY = {
	nextCursor: {
		type: ["string", "null"],
		description: "The cursor to send back for the next page, or null on the last one.",
	},
};

/**
 * Builds the OpenAPI 3.1 description of every endpoint under `/api/v1`.
 *
 * Unauthenticated by design: the document describes the shape of the API rather than the contents
 * of this install, and a client generator reading it should not need a credential to do so. Nothing
 * below names an actual agent, device, asset or job — every example is either absent or generic.
 *
 * @param publicUrl the address this server is reachable at — see `getPublicAddress` in
 *   `lib/public-url.ts`, whose caller passes its `url` straight through. That function always
 *   resolves to a string, configured or inferred from the request, so there is no "unresolved"
 *   case for this to fall back from.
 * @returns the OpenAPI document, ready to serialise as JSON
 */
export function openApiDocument(publicUrl: string): object {
	return {
		openapi: "3.1.0",
		info: {
			title: "FenPOS",
			version: API_VERSION,
			description:
				"The FenPOS public API — submitting print jobs, following them, and managing the devices and assets a key is granted. Requests carry a markup language of their own; see the panel's own /docs/markup page for its reference, since that language has no separate machine-readable schema.",
		},
		servers: [{ url: publicUrl }],
		security: BEARER_AUTH,
		// A vendor extension rather than a standard field: OpenAPI has no closed vocabulary for the
		// grants an install's own security model defines. Listed once from PERMISSION_IDS, the
		// vocabulary's own source of truth, so the set here cannot drift from what a key can actually
		// be granted even if a permission's name changes in a route's own description text below.
		"x-permissions": PERMISSION_IDS,
		components: {
			securitySchemes: {
				bearerAuth: {
					type: "http",
					scheme: "bearer",
					description: "An API key created on the panel's `API keys` tab, sent as `Authorization: Bearer fpk_…`.",
				},
			},
			schemas: {
				Error: {
					type: "object",
					description:
						"Every non-2xx response shares this shape. `error` is the stable field to branch on; `message` is for people and is explicitly not part of the contract, so its wording may change without that being a breaking change. A content error additionally carries `line` and, where the fault is one character, `column`.",
					properties: {
						error: {
							type: "string",
							enum: Object.keys(API_ERROR_STATUS),
							description: "Stable machine-readable code. The only field to branch on.",
						},
						message: { type: "string", description: "Human-readable explanation. Not part of the contract." },
					},
					required: ["error", "message"],
				},
			},
		},
		paths: {
			[`${API_BASE}/openapi.json`]: {
				get: {
					summary: "This document.",
					operationId: "getOpenApiDocument",
					description: "Unauthenticated. Returns this OpenAPI description of the API.",
					security: NO_AUTH,
					responses: {
						200: jsonResponse("The OpenAPI document.", { type: "object" }),
					},
				},
			},

			[`${API_BASE}/print/{agent}/{device}`]: {
				post: {
					summary: "Submit a receipt to one printer.",
					operationId: "submitPrintJob",
					description:
						"Requires the `print` permission. Compiles the body against the named device and hands it to the agent. An optional `Idempotency-Key` header makes a retry safe: a repeated key addressed to the same device with a byte-identical body replays the original `202` and prints nothing a second time. It is replayable for as long as the job row exists — in practice indefinitely, since nothing sweeps this server's jobs table.",
					security: BEARER_AUTH,
					parameters: [pathParam("agent"), pathParam("device"), idempotencyKeyHeader()],
					requestBody: { required: true, content: { "application/json": { schema: PRINT_REQUEST_SCHEMA } } },
					responses: {
						202: jsonResponse(
							"Accepted. The job was compiled, recorded and handed to the agent — it has not printed yet. A replay of a previous idempotent submit carries the same body and an `Idempotent-Replay: true` header.",
							{
								type: "object",
								properties: {
									jobId: { type: "string" },
									status: { type: "string", enum: ["QUEUED"] },
									device: { type: "string" },
									lines: { type: "integer" },
								},
								required: ["jobId", "status", "device", "lines"],
							},
						),
						default: ERROR_RESPONSE,
					},
				},
			},

			[`${API_BASE}/preview/{agent}/{device}`]: {
				post: {
					summary: "Compile a receipt without printing it.",
					operationId: "previewPrintJob",
					description:
						"Requires the `print` permission, the same one submitting a job needs — preview is strictly less powerful and reveals nothing a key holding `print` could not already learn by printing. Always answers `200`, including when the markup does not compile: the request succeeded, and 'it would not print' is a complete answer to what was asked.",
					security: BEARER_AUTH,
					parameters: [pathParam("agent"), pathParam("device")],
					requestBody: { required: true, content: { "application/json": { schema: PRINT_REQUEST_SCHEMA } } },
					responses: {
						200: jsonResponse("The compiled preview, or everything wrong with the receipt.", PREVIEW_SCHEMA),
						default: ERROR_RESPONSE,
					},
				},
			},

			[`${API_BASE}/jobs`]: {
				get: {
					summary: "List the jobs this key submitted.",
					operationId: "listJobs",
					description:
						"Requires the `jobs:read` permission. Scoped to the key, not to the device: two systems sharing a printer cannot read each other's receipts. Newest first, cursor-paginated.",
					security: BEARER_AUTH,
					parameters: [
						...PAGE_PARAMS,
						{
							name: "status",
							in: "query",
							required: false,
							schema: { type: "string", enum: JobStatus.values },
						},
						{ name: "agent", in: "query", required: false, schema: { type: "string" } },
						{ name: "device", in: "query", required: false, schema: { type: "string" } },
						{
							name: "since",
							in: "query",
							required: false,
							schema: { type: "string", format: "date-time" },
							description: "Narrows to jobs submitted at or after this moment.",
						},
					],
					responses: {
						200: jsonResponse("The caller's own job history.", {
							type: "object",
							properties: { jobs: { type: "array", items: JOB_SCHEMA }, ...NEXT_CURSOR_PROPERTY },
							required: ["jobs", "nextCursor"],
						}),
						default: ERROR_RESPONSE,
					},
				},
			},

			[`${API_BASE}/jobs/{id}`]: {
				get: {
					summary: "Read one job.",
					operationId: "getJob",
					description:
						"Requires the `jobs:read` permission. A key sees only the jobs it submitted itself; a job belonging to another key is reported as `unknown_job`, exactly as one that does not exist.",
					security: BEARER_AUTH,
					parameters: [pathParam("id")],
					responses: {
						200: jsonResponse("The job.", JOB_SCHEMA),
						default: ERROR_RESPONSE,
					},
				},
				delete: {
					summary: "Cancel a job that has not started printing.",
					operationId: "cancelJob",
					description:
						"Requires the `jobs:cancel` permission. Cancellation is a request to the agent, not a fact this server can assert on its own — only the machine holding the printer knows whether the job is still waiting.",
					security: BEARER_AUTH,
					parameters: [pathParam("id")],
					responses: {
						202: jsonResponse("The cancellation was passed on. The job's final state arrives from the agent.", {
							type: "object",
							properties: { jobId: { type: "string" }, status: { type: "string", enum: ["CANCELLING"] } },
							required: ["jobId", "status"],
						}),
						default: ERROR_RESPONSE,
					},
				},
			},

			[`${API_BASE}/devices`]: {
				get: {
					summary: "List the printers this key may address.",
					operationId: "listDevices",
					description:
						"Requires the `devices:read` permission. The list is the key's grant, not the install: a key confined to one site learns nothing about the rest. Not paginated.",
					security: BEARER_AUTH,
					responses: {
						200: jsonResponse("The granted devices.", {
							type: "object",
							properties: { devices: { type: "array", items: DEVICE_SCHEMA } },
							required: ["devices"],
						}),
						default: ERROR_RESPONSE,
					},
				},
			},

			[`${API_BASE}/devices/{agent}/{device}`]: {
				get: {
					summary: "Read one printer's configuration and state.",
					operationId: "getDevice",
					description:
						"Requires the `devices:read` permission. A device this key does not grant is reported as `unknown_device`, exactly as one that does not exist.",
					security: BEARER_AUTH,
					parameters: [pathParam("agent"), pathParam("device")],
					responses: {
						200: jsonResponse("The device.", DEVICE_SCHEMA),
						default: ERROR_RESPONSE,
					},
				},
			},

			[`${API_BASE}/devices/{agent}/{device}/actions`]: {
				post: {
					summary: "Ask an agent to act on one printer.",
					operationId: "actOnDevice",
					description:
						"Requires the `devices:control` permission. `pause` and `resume` also write this server's stored desired state, so it survives an agent restart; the rest are sends only. There is no `test` action — printing a diagnostic page is a print, and is gated by `print` instead.",
					security: BEARER_AUTH,
					parameters: [pathParam("agent"), pathParam("device")],
					requestBody: {
						required: true,
						content: {
							"application/json": {
								schema: {
									type: "object",
									properties: { action: { type: "string", enum: API_DEVICE_ACTIONS } },
									required: ["action"],
								},
							},
						},
					},
					responses: {
						200: jsonResponse("The action was sent.", {
							type: "object",
							properties: {
								agent: { type: "string" },
								device: { type: "string" },
								action: { type: "string", enum: API_DEVICE_ACTIONS },
								message: { type: ["string", "null"], description: "The agent's own reply, if it sent one." },
							},
							required: ["agent", "device", "action", "message"],
						}),
						default: ERROR_RESPONSE,
					},
				},
			},

			[`${API_BASE}/devices/{agent}/{device}/raw`]: {
				post: {
					summary: "Write raw ESC/POS bytes to one printer.",
					operationId: "writeRawBytes",
					description:
						"Requires the `devices:raw` permission *and* the install's `link.allowRawApiWrites` setting, which ships off — the permission alone grants nothing. The bytes are base64 in `bytes` and reach the hardware unmodified: no wrapping, no codepage validation, no width calculation, and none of the limits the print endpoint applies. `link.maxRawWriteBytes` is the only bound on one. While the setting is off every caller gets `raw_writes_disabled`, decided before the device grant is checked so the refusal cannot be used to discover which printers exist. Nothing in the response describes what was printed: the bytes are never read here, and a write that times out is reported as one that may or may not have reached the paper.",
					security: BEARER_AUTH,
					parameters: [pathParam("agent"), pathParam("device")],
					requestBody: {
						required: true,
						content: {
							"application/json": {
								schema: {
									type: "object",
									properties: {
										bytes: { type: "string", description: "The payload, base64 encoded. Sent to the printer unread." },
									},
									required: ["bytes"],
								},
							},
						},
					},
					responses: {
						200: jsonResponse("The bytes were handed to the agent.", {
							type: "object",
							properties: {
								agent: { type: "string" },
								device: { type: "string" },
								bytes: { type: "integer", description: "How many decoded bytes were sent." },
								message: { type: ["string", "null"], description: "The agent's own reply, if it sent one." },
							},
							required: ["agent", "device", "bytes", "message"],
						}),
						default: ERROR_RESPONSE,
					},
				},
			},

			[`${API_BASE}/status`]: {
				get: {
					summary: "Agent liveness and printer readiness.",
					operationId: "getStatus",
					description:
						"Requires the `status:read` permission. Grouped by agent, restricted to the agents holding at least one device this key is granted. Distinct from the unauthenticated `/api/health`, which stays deliberately contentless.",
					security: BEARER_AUTH,
					responses: {
						200: jsonResponse("Agent and device status, grouped by agent.", {
							type: "object",
							properties: {
								agents: {
									type: "array",
									items: {
										type: "object",
										properties: {
											agent: { type: "string" },
											status: { type: "string", enum: AgentStatus.values },
											lastSeenAt: { type: ["string", "null"], format: "date-time" },
											agentVersion: { type: ["string", "null"] },
											devices: { type: "array", items: DEVICE_SCHEMA },
										},
										required: ["agent", "status", "lastSeenAt", "agentVersion", "devices"],
									},
								},
							},
							required: ["agents"],
						}),
						default: ERROR_RESPONSE,
					},
				},
			},

			[`${API_BASE}/assets`]: {
				get: {
					summary: "List the stored images markup can reference.",
					operationId: "listAssets",
					description:
						"Requires the `assets:read` permission. Install-wide, not scoped to a key's devices — the panel, the markup resolver and every key see one namespace. Ordered by name ascending, unlike the jobs listing's newest-first — an image library is browsed alphabetically. Cursor-paginated, without the image bytes.",
					security: BEARER_AUTH,
					parameters: PAGE_PARAMS,
					responses: {
						200: jsonResponse("The stored assets.", {
							type: "object",
							properties: { assets: { type: "array", items: ASSET_SUMMARY_SCHEMA }, ...NEXT_CURSOR_PROPERTY },
							required: ["assets", "nextCursor"],
						}),
						default: ERROR_RESPONSE,
					},
				},
				post: {
					summary: "Store an image.",
					operationId: "createAsset",
					description:
						"Requires the `assets:write` permission — a broader grant than any device permission, since assets are install-wide. The body names exactly one source for the bytes: `data`, a base64-encoded upload, or `url`, a location to import from.",
					security: BEARER_AUTH,
					requestBody: {
						required: true,
						content: {
							"application/json": {
								schema: {
									type: "object",
									properties: {
										name: { type: "string" },
										data: { type: "string", description: "The image, base64 encoded. Exclusive with `url`." },
										url: { type: "string", description: "A location to import the image from. Exclusive with `data`." },
									},
									required: ["name"],
								},
							},
						},
					},
					responses: {
						// The same schema `GET` lists with, not a second shape carrying the row id: a caller
						// addresses an asset by the name it chose, exactly as `DELETE /assets/{name}` does, and
						// publishing the id here would be a second way to name the same thing.
						201: jsonResponse("The stored asset.", ASSET_SUMMARY_SCHEMA),
						default: ERROR_RESPONSE,
					},
				},
			},

			[`${API_BASE}/assets/{name}`]: {
				delete: {
					summary: "Remove a stored image.",
					operationId: "deleteAsset",
					description:
						"Requires the `assets:write` permission — a delete is a write. A receipt still naming this image will fail to compile with `unknown_asset` afterwards.",
					security: BEARER_AUTH,
					parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }],
					responses: {
						204: emptyResponse("The asset is gone. No body: there is nothing left to describe."),
						default: ERROR_RESPONSE,
					},
				},
			},
		},
	};
}

/**
 * A required string path parameter, named the way every agent/device-scoped route names it.
 *
 * Pulled out because every path below but two repeats it verbatim, and a hand-typed copy in each
 * one is exactly the kind of duplication that drifts silently when one of them is edited and the
 * others are not.
 *
 * @param name the path segment's name, as the route file's own bracket names it
 * @returns an OpenAPI path parameter
 */
function pathParam(name: string): object {
	return { name, in: "path", required: true, schema: { type: "string" } };
}

/**
 * The optional `Idempotency-Key` header the print endpoint reads.
 *
 * @returns an OpenAPI header parameter
 */
function idempotencyKeyHeader(): object {
	return {
		name: "Idempotency-Key",
		in: "header",
		required: false,
		schema: { type: "string" },
		description: "Makes a retry safe. See the operation description for what a repeat of it does.",
	};
}
