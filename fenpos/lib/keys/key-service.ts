import "server-only";
import { generateToken, hashSecret } from "@/lib/auth/secrets";
import { prisma } from "@/lib/db";
import { nameSchema } from "@/lib/domain/naming";
import { type Permission, parseStoredPermissions, permissionSchema } from "@/lib/domain/permissions";
import { ApiError } from "@/lib/errors";
import { logger } from "@/lib/logger";

/**
 * API key lifecycle: minting, granting, revoking.
 *
 * **A key is shown once and stored only as a hash.** There is no route back from the database to
 * the secret, by construction — not as a precaution but as the whole design. A panel that could
 * redisplay a key would mean a database dump was a set of working credentials, and every backup
 * of it would be too.
 *
 * The hash is deterministic rather than salted. That is right here and wrong for passwords: a key
 * is 256 bits of CSPRNG output with no brute-force surface for a slow KDF to defend, and a
 * deterministic hash is what lets an incoming bearer token resolve in one indexed lookup instead
 * of a scan-and-verify over every row.
 */

/** Characters of the key shown in the panel, so an operator can tell two keys apart. */
const HINT_LENGTH = 6;

/** Prefix every key carries, so one found in a log or a config file is recognisable. */
const KEY_PREFIX = "fpk_";

/** A key as the Keys page displays it. */
export interface ApiKeySummary {
	id: string;
	name: string;
	maskedHint: string;
	createdAt: Date;
	lastUsedAt: Date | null;
	revokedAt: Date | null;
	permissions: Permission[];
	/** The devices this key may print to, by id and name. */
	devices: { id: string; name: string; agentName: string }[];
}

/** A newly minted key, with the one and only sight of its secret. */
export interface MintedKey {
	id: string;
	/** The full key. Never stored, never recoverable, shown exactly once. */
	secret: string;
}

/**
 * Lists every key for the panel.
 *
 * @returns keys ordered by creation, newest first
 */
export async function listApiKeys(): Promise<ApiKeySummary[]> {
	const rows = await prisma.apiKey.findMany({
		orderBy: { createdAt: "desc" },
		include: {
			permissions: { select: { permission: true } },
			devices: {
				select: { device: { select: { id: true, name: true, agent: { select: { name: true } } } } },
			},
		},
	});

	return rows.map((row) => ({
		id: row.id,
		name: row.name,
		maskedHint: row.maskedHint,
		createdAt: row.createdAt,
		lastUsedAt: row.lastUsedAt,
		revokedAt: row.revokedAt,
		permissions: parseStoredPermissions(row.permissions.map((entry) => entry.permission)),
		devices: row.devices.map((entry) => ({
			id: entry.device.id,
			name: entry.device.name,
			agentName: entry.device.agent.name,
		})),
	}));
}

/**
 * Mints a key and returns its secret once.
 *
 * @param rawName what to call it in the panel
 * @param permissions what it may do
 * @param deviceIds which printers it may address
 * @returns the new key's id and its secret
 * @throws ApiError when the name or a permission is not valid
 */
export async function createApiKey(rawName: string, permissions: string[], deviceIds: string[]): Promise<MintedKey> {
	const name = parseName(rawName);
	const granted = parsePermissions(permissions);

	// Existence is checked rather than assumed: a grant naming a device that was deleted between
	// the form rendering and the submit would otherwise fail on a foreign key with a message
	// nobody can act on.
	await requireDevicesExist(deviceIds);

	const secret = KEY_PREFIX + generateToken();

	const key = await prisma.apiKey.create({
		data: {
			name,
			keyHash: hashSecret(secret),
			maskedHint: secret.slice(-HINT_LENGTH),
			permissions: { create: granted.map((permission) => ({ permission })) },
			devices: { create: deviceIds.map((deviceId) => ({ deviceId })) },
		},
		select: { id: true },
	});

	logger.info("API key created", { keyId: key.id, name, permissions: granted, devices: deviceIds.length });
	return { id: key.id, secret };
}

/**
 * Replaces a key's permissions and device grants.
 *
 * Replaced wholesale rather than merged, so the form is the whole truth about what a key can do.
 * A merge would make removing a grant impossible from the same screen that added it.
 *
 * @param keyId the key to change
 * @param permissions what it may do from now on
 * @param deviceIds which printers it may address from now on
 * @throws ApiError when the key is unknown or a permission is not valid
 */
export async function updateApiKeyGrants(keyId: string, permissions: string[], deviceIds: string[]): Promise<void> {
	const granted = parsePermissions(permissions);
	await requireKey(keyId);
	await requireDevicesExist(deviceIds);

	await prisma.$transaction([
		prisma.apiKeyPermission.deleteMany({ where: { apiKeyId: keyId } }),
		prisma.apiKeyDevice.deleteMany({ where: { apiKeyId: keyId } }),
		prisma.apiKeyPermission.createMany({
			data: granted.map((permission) => ({ apiKeyId: keyId, permission })),
		}),
		prisma.apiKeyDevice.createMany({
			data: deviceIds.map((deviceId) => ({ apiKeyId: keyId, deviceId })),
		}),
	]);

	logger.info("API key grants updated", { keyId, permissions: granted, devices: deviceIds.length });
}

/**
 * Renames a key.
 *
 * @param keyId the key to rename
 * @param rawName the new name
 * @throws ApiError when the key is unknown or the name is not valid
 */
export async function renameApiKey(keyId: string, rawName: string): Promise<void> {
	const name = parseName(rawName);
	await requireKey(keyId);
	await prisma.apiKey.update({ where: { id: keyId }, data: { name } });
}

/**
 * Revokes a key, immediately and irreversibly.
 *
 * The row is kept rather than deleted so the jobs it submitted keep their attribution. A revoked
 * key is refused at the boundary, so keeping it costs nothing and losing the audit trail would.
 *
 * @param keyId the key to revoke
 * @throws ApiError when the key is unknown or already revoked
 */
export async function revokeApiKey(keyId: string): Promise<void> {
	const key = await requireKey(keyId);
	if (key.revokedAt) {
		throw new ApiError("invalid_type", "That key is already revoked.");
	}

	await prisma.apiKey.update({ where: { id: keyId }, data: { revokedAt: new Date() } });
	logger.info("API key revoked", { keyId });
}

/**
 * Deletes a key and its grants.
 *
 * Offered alongside revoking because a key created by mistake and never used has no history worth
 * keeping. Jobs it submitted keep their rows; their key reference is cleared.
 *
 * @param keyId the key to delete
 * @throws ApiError when the key is unknown
 */
export async function deleteApiKey(keyId: string): Promise<void> {
	await requireKey(keyId);
	await prisma.apiKey.delete({ where: { id: keyId } });
	logger.info("API key deleted", { keyId });
}

/** Validates a key name, which is display text rather than a path segment. */
function parseName(rawName: string): string {
	const trimmed = (rawName ?? "").trim();
	if (trimmed.length === 0) {
		throw new ApiError("missing_field", "A name is required.");
	}
	if (trimmed.length > 64) {
		throw new ApiError("invalid_type", "Name must be at most 64 characters.");
	}
	return trimmed;
}

/** Validates permission identifiers arriving from a form. */
function parsePermissions(permissions: string[]): Permission[] {
	const parsed: Permission[] = [];
	for (const candidate of permissions) {
		const result = permissionSchema.safeParse(candidate);
		if (!result.success) {
			throw new ApiError("invalid_type", `'${candidate}' is not a permission.`);
		}
		if (!parsed.includes(result.data)) {
			parsed.push(result.data);
		}
	}
	return parsed;
}

async function requireKey(keyId: string): Promise<{ id: string; revokedAt: Date | null }> {
	const key = await prisma.apiKey.findUnique({
		where: { id: keyId },
		select: { id: true, revokedAt: true },
	});
	if (!key) {
		throw new ApiError("invalid_key", "That key no longer exists.");
	}
	return key;
}

async function requireDevicesExist(deviceIds: string[]): Promise<void> {
	if (deviceIds.length === 0) {
		return;
	}
	const found = await prisma.device.count({ where: { id: { in: deviceIds } } });
	if (found !== new Set(deviceIds).size) {
		throw new ApiError("unknown_device", "One of those printers no longer exists.");
	}
}

/** Exported so the naming rules stay reachable from the form that applies them. */
export { nameSchema };
