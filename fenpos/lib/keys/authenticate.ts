import "server-only";
import { hashSecret } from "@/lib/auth/secrets";
import { prisma } from "@/lib/db";
import { type Permission, parseStoredPermissions } from "@/lib/domain/permissions";
import { ApiError } from "@/lib/errors";
import { logger } from "@/lib/logger";

/**
 * Resolving a bearer token to what it is allowed to do.
 *
 * Three checks, and the order they fail in is deliberate:
 *
 * 1. **No key, or an unknown one** → `401`. The caller is not identified.
 * 2. **A key without the permission** → `403`. Identified, but not allowed to do this.
 * 3. **A key without a grant for the device** → `404`, *not* `403`. Deliberately
 *    indistinguishable from a device that does not exist, so a caller cannot enumerate the
 *    install's printers by probing for the difference between "exists but forbidden" and "no
 *    such thing". A key confined to one site learns nothing about the others.
 *
 * The absence of any grant row means the key grants no devices. That default matters: a key
 * created but not yet configured must be inert, never permissive.
 */

/** An authenticated caller and what it may do. */
export interface AuthenticatedKey {
	id: string;
	name: string;
	permissions: Permission[];
}

/**
 * Extracts a bearer token from an Authorization header.
 *
 * @param header the raw header value
 * @returns the token, or null when the header is absent or not a bearer credential
 */
export function bearerToken(header: string | null): string | null {
	if (!header) {
		return null;
	}
	const match = /^Bearer\s+(.+)$/i.exec(header.trim());
	return match ? match[1].trim() : null;
}

/**
 * Resolves a request's credential to the key that holds it.
 *
 * `lastUsedAt` is recorded but not awaited: an operator wants to know whether a key is still in
 * use, and that is not worth adding a database round trip to the latency of every print.
 *
 * @param request the incoming request
 * @returns the key and its permissions
 * @throws ApiError when no valid, unrevoked key was presented
 */
export async function authenticateKey(request: Request): Promise<AuthenticatedKey> {
	const token = bearerToken(request.headers.get("authorization"));
	if (!token) {
		throw new ApiError("missing_key", "Provide an API key as 'Authorization: Bearer <key>'.");
	}

	const key = await prisma.apiKey.findUnique({
		where: { keyHash: hashSecret(token) },
		select: {
			id: true,
			name: true,
			revokedAt: true,
			permissions: { select: { permission: true } },
		},
	});

	// One response for an unknown key and for a revoked one, so the endpoint cannot be used to
	// test whether a key was ever valid.
	if (!key || key.revokedAt) {
		throw new ApiError("invalid_key", "That API key is not valid.");
	}

	void prisma.apiKey
		.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } })
		.catch((error) => logger.warn("Could not record key usage", { keyId: key.id, error: String(error) }));

	return {
		id: key.id,
		name: key.name,
		permissions: parseStoredPermissions(key.permissions.map((entry) => entry.permission)),
	};
}

/**
 * Requires a permission, refusing the call if the key lacks it.
 *
 * @param key the authenticated caller
 * @param permission what the endpoint needs
 * @throws ApiError when the key does not hold it
 */
export function requirePermission(key: AuthenticatedKey, permission: Permission): void {
	if (!key.permissions.includes(permission)) {
		throw new ApiError("insufficient_permission", `This key does not have '${permission}'.`);
	}
}

/**
 * Resolves an agent-scoped device path to a device this key may address.
 *
 * @param key the authenticated caller
 * @param agentName the agent named in the path
 * @param deviceName the device named in the path
 * @returns the device
 * @throws ApiError `unknown_device` when it does not exist, or exists and is not granted
 */
export async function requireGrantedDevice(
	key: AuthenticatedKey,
	agentName: string,
	deviceName: string,
): Promise<{ id: string; name: string; agentId: string }> {
	const device = await prisma.device.findFirst({
		where: { name: deviceName, agent: { name: agentName } },
		select: { id: true, name: true, agentId: true },
	});

	if (!device) {
		throw new ApiError("unknown_device", `No device '${deviceName}' on agent '${agentName}'.`);
	}

	const granted = await prisma.apiKeyDevice.findUnique({
		where: { apiKeyId_deviceId: { apiKeyId: key.id, deviceId: device.id } },
		select: { deviceId: true },
	});

	if (!granted) {
		// Same error as a device that does not exist. Distinguishing them would let a caller map
		// every printer in the install by probing names and watching which answer came back.
		logger.warn("Key addressed a device it has no grant for", {
			keyId: key.id,
			agentName,
			deviceName,
		});
		throw new ApiError("unknown_device", `No device '${deviceName}' on agent '${agentName}'.`);
	}

	return device;
}

/** A device a key may address, with the agent identity its observed state is keyed by. */
export interface GrantedDevice {
	id: string;
	name: string;
	agentId: string;
	agentName: string;
	port: string;
	columns: number;
	codepage: string;
	defaultLinefeed: string;
	paused: boolean;
	maxQueueDepth: number | null;
}

/**
 * Every device this key grants.
 *
 * The listing counterpart to {@link requireGrantedDevice}, and it inherits that function's rule:
 * what is not granted is not merely forbidden, it is invisible. A listing that returned the whole
 * install with a `granted` flag would hand a caller the printer map that `requireGrantedDevice`
 * refuses to confirm one name at a time.
 *
 * Ordered by agent then device name so a caller rendering a picker gets a stable list rather than
 * whatever order the grants happened to be written in.
 *
 * @param key the authenticated caller
 * @returns the granted devices, agent-major
 */
export async function grantedDevices(key: AuthenticatedKey): Promise<GrantedDevice[]> {
	const grants = await prisma.apiKeyDevice.findMany({
		where: { apiKeyId: key.id },
		select: {
			device: {
				select: {
					id: true,
					name: true,
					agentId: true,
					port: true,
					columns: true,
					codepage: true,
					defaultLinefeed: true,
					paused: true,
					maxQueueDepth: true,
					agent: { select: { name: true } },
				},
			},
		},
	});

	return grants
		.map((grant) => ({
			id: grant.device.id,
			name: grant.device.name,
			agentId: grant.device.agentId,
			agentName: grant.device.agent.name,
			port: grant.device.port,
			columns: grant.device.columns,
			codepage: grant.device.codepage,
			defaultLinefeed: grant.device.defaultLinefeed,
			paused: grant.device.paused,
			maxQueueDepth: grant.device.maxQueueDepth,
		}))
		.sort(
			// "en" pinned explicitly rather than left to the platform default: ICU collation
			// varies by host locale, and this order is promised as stable in the JSDoc above —
			// stable has to mean the same order on every machine that runs this, not just within
			// one run of it.
			(a, b) => a.agentName.localeCompare(b.agentName, "en") || a.name.localeCompare(b.name, "en"),
		);
}

/**
 * Resolves one device to the full shape {@link grantedDevices} returns for each of its entries.
 *
 * Built on {@link requireGrantedDevice} rather than reimplementing the grant check, so this
 * inherits its security property exactly: a device the key has no grant for and a device that
 * does not exist raise the identical `unknown_device` message, and the ungranted case logs the
 * same warning `requireGrantedDevice` does. That indistinguishability is what stops a caller
 * mapping the install's printers by probing names, and it has to hold here too, not just on the
 * path this is built from.
 *
 * `requireGrantedDevice` itself stays narrow on purpose — it is on the print hot path and returns
 * only what dispatch needs — so the wider row this endpoint wants is read here, as a second query
 * against the id it already resolved.
 *
 * @param key the authenticated caller
 * @param agentName the agent named in the path
 * @param deviceName the device named in the path
 * @returns the device in the shared `GrantedDevice` shape
 * @throws ApiError `unknown_device` when it does not exist, is not granted, or was deleted between
 *   the grant check and this read
 */
export async function grantedDevice(
	key: AuthenticatedKey,
	agentName: string,
	deviceName: string,
): Promise<GrantedDevice> {
	const target = await requireGrantedDevice(key, agentName, deviceName);

	const row = await prisma.device.findUnique({
		where: { id: target.id },
		select: {
			id: true,
			name: true,
			agentId: true,
			port: true,
			columns: true,
			codepage: true,
			defaultLinefeed: true,
			paused: true,
			maxQueueDepth: true,
			agent: { select: { name: true } },
		},
	});

	if (!row) {
		// Deleted between the grant check and this read. Reported as unknown rather than as a
		// fault, because from the caller's side that is exactly what it is.
		throw new ApiError("unknown_device", `No device '${deviceName}' on agent '${agentName}'.`);
	}

	return {
		id: row.id,
		name: row.name,
		agentId: row.agentId,
		agentName: row.agent.name,
		port: row.port,
		columns: row.columns,
		codepage: row.codepage,
		defaultLinefeed: row.defaultLinefeed,
		paused: row.paused,
		maxQueueDepth: row.maxQueueDepth,
	};
}
