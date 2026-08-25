import "server-only";
import { z } from "zod";

/**
 * Validated process environment.
 *
 * Parsed once at module load and reported in full: if three variables are wrong, the
 * operator sees all three rather than fixing them one restart at a time. This mirrors how
 * the agent reports configuration problems, and it exists for the same reason — a daemon
 * that starts with a half-valid configuration fails later, further from the cause.
 *
 * Importing this module from client code is a build error, because a leaked DATABASE_URL
 * would be a real disclosure.
 */

/**
 * The environment variables this server validates at startup.
 *
 * Exported — not merely used internally — so a test can assert on its shape directly, such as
 * confirming a removed variable stays removed. See `public-url.test.ts`.
 */
export const envSchema = z.object({
	/**
	 * SQLite connection string, e.g. `file:./data/fenpos.db`. Relative paths resolve from the
	 * server directory. In Docker this must point at a mounted volume.
	 */
	DATABASE_URL: z
		.string()
		.min(1, "must be set, e.g. file:./data/fenpos.db")
		.refine((value) => value.startsWith("file:"), {
			message: "must be a SQLite file URL beginning with file:",
		}),

	/**
	 * Signing key for Better Auth's cookies and tokens.
	 *
	 * Required with no default, deliberately. A generated-if-absent fallback would mean every
	 * restart silently invalidated every session, and a checked-in default would mean every
	 * install shared a signing key — which is not a weak secret but no secret at all.
	 *
	 * The 32-character floor is a shape check, not an entropy measure: it stops an operator
	 * pasting a word, and nothing here can tell a strong 32-byte value from a weak one. Generate
	 * with `openssl rand -base64 32`.
	 */
	BETTER_AUTH_SECRET: z.string().min(32, "must be at least 32 characters; generate with `openssl rand -base64 32`"),

	/**
	 * Absolute origin the panel is reached on, e.g. `https://pos.example.com`.
	 *
	 * Optional: left unset, Better Auth derives the origin from the incoming request, which is
	 * correct for a LAN install reached by address. Set it when the panel sits behind a proxy
	 * that rewrites the host, because a wrong origin makes cookies silently fail to set — a
	 * failure that presents as "sign-in does nothing" rather than as an error.
	 *
	 * Distinct from the `server.publicUrl` setting, which is the address *agents* dial. The two
	 * are usually the same and are allowed to differ.
	 */
	BETTER_AUTH_URL: z
		.string()
		.refine((value) => /^https?:\/\/[^\s/$.?#][^\s]*$/i.test(value), "must be an absolute http or https URL")
		.optional(),

	/** Port the combined Next.js and WebSocket server listens on. */
	PORT: z.coerce.number().int().min(1).max(65535).default(3000),

	NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

/** The shape of the validated environment. */
export type Env = z.infer<typeof envSchema>;

/**
 * Parses the environment, throwing with every problem listed rather than only the first.
 *
 * @param source the raw environment to validate
 * @returns the validated and coerced environment
 * @throws Error when any variable is missing or malformed
 */
function parseEnv(source: NodeJS.ProcessEnv): Env {
	const result = envSchema.safeParse(source);

	if (!result.success) {
		const problems = result.error.issues
			.map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
			.join("\n");
		throw new Error(`Environment is unusable, refusing to start:\n${problems}`);
	}

	return result.data;
}

export const env: Env = parseEnv(process.env);

/** Whether this process is running a production build. */
export const isProduction = env.NODE_ENV === "production";
