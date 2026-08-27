/**
 * Where FenPOS's sibling databases live, relative to the application database.
 *
 * Its own module, and deliberately free of `import "server-only"` and of every other import: this
 * rule has to be readable both by the running server through `lib/env.ts` and by the Prisma CLI
 * through `prisma-logs.config.ts`, and the CLI runs outside Next's bundler where a `server-only`
 * import throws. One module both can reach is what keeps the CLI and the server from deriving the
 * same path from two copies of the rule that can drift apart.
 */

/**
 * Replaces the filename in a `file:` URL, keeping its directory.
 *
 * Both separators are accepted because the two callers supply different shapes: `.env` holds a
 * POSIX-style `file:./data/fenpos.db`, while the test harness builds its URL with `node:path`,
 * which on Windows yields backslashes. Splitting on only one of them would silently return
 * `file:logs.db` — a path relative to the working directory — instead of failing.
 *
 * @param url the application database's URL, e.g. `file:./data/fenpos.db`
 * @param filename the sibling to address, e.g. `logs.db`
 * @returns the sibling's URL
 */
export function siblingDatabaseUrl(url: string, filename: string): string {
	const withoutScheme = url.replace(/^file:/, "");
	const lastSeparator = Math.max(withoutScheme.lastIndexOf("/"), withoutScheme.lastIndexOf("\\"));
	const directory = withoutScheme.slice(0, lastSeparator + 1);

	return `file:${directory}${filename}`;
}
