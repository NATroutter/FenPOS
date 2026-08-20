import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createAsset, storedImageSize } from "../lib/assets/asset-service";
import { prisma } from "../lib/db";
import { ApiError } from "../lib/errors";

/**
 * Puts the application's own logo into the asset library, if it is not there already.
 *
 * `<image>` draws from stored assets and from nothing else, so an install where nobody has
 * uploaded a picture has no way to exercise the image path at all — including the device test
 * page, which prints the logo. This is the one asset the product ships with, so it is the one
 * asset worth seeding.
 *
 * Usage:
 *   pnpm db:seed:logo
 *
 * **Idempotent, and unlike `db:seed` it deletes nothing.** Running it twice leaves the first copy
 * alone rather than replacing it: an operator may have replaced the logo with their own, and a
 * seed script is not the place to overwrite that. Delete the asset from the Assets tab first if a
 * fresh copy is what you want.
 *
 * The bytes go through {@link createAsset} rather than into a row directly, so this file gets the
 * same decode, the same size and dimension limits, and the same name rules as an upload. Writing
 * the row here would be shorter and would be the sort of shortcut that leaves a database holding
 * something the application's own validation would have refused.
 *
 * **Needs `--conditions=react-server`**, which `db:seed:logo` supplies. `asset-service.ts` is
 * marked `server-only`, a package whose whole job is to throw when it is resolved outside a server
 * context; that condition is the documented way to say this is one. The alternative is a copy of
 * the storage path that is not `server-only`, which is the drift this script exists to avoid.
 */

/** What markup refers to the logo by. `TestPage.java` and the panel's test page name this string. */
const NAME = "fenpos-logo";

/** Where the file lives, relative to the package root this script is run from. */
const SOURCE = path.join("public", "fenpos-logo.png");

async function main(): Promise<void> {
	if (!process.env.DATABASE_URL) {
		throw new Error("DATABASE_URL is not set. Copy .env.example to .env first.");
	}

	try {
		const existing = await storedImageSize(NAME);
		process.stdout.write(`'${NAME}' is already stored (${existing.width}x${existing.height}). Nothing to do.\n`);
		return;
	} catch (thrown) {
		// Anything but "there is no such image" is a real failure — an unreachable database, a row
		// with no dimensions — and must not be swallowed into a create that then fails differently.
		if (!(thrown instanceof ApiError) || thrown.code !== "unknown_asset") {
			throw thrown;
		}
	}

	const bytes = await readFile(SOURCE);
	const stored = await createAsset(NAME, bytes);

	process.stdout.write(`Stored '${stored.name}' (${stored.width}x${stored.height}, ${bytes.length} bytes).\n`);
	process.stdout.write("Agents receive it on their next config sync.\n");
}

main()
	.catch((error: unknown) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	})
	.finally(() => prisma.$disconnect());
