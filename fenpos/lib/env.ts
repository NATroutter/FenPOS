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

const envSchema = z.object({
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

	/** Port the combined Next.js and WebSocket server listens on. */
	PORT: z.coerce.number().int().min(1).max(65535).default(3000),

	/**
	 * The address agents should dial, e.g. `https://fenpos.example.com`.
	 *
	 * Optional. When unset, the panel derives the address from the request that rendered it,
	 * which is correct for a direct connection and usually correct behind a proxy that sets
	 * the forwarded headers. Set it explicitly when the panel is reached on a different
	 * address than agents should use — an internal hostname versus a public one, say —
	 * because an operator copying the wrong address gets a agent that silently never connects.
	 */
	PUBLIC_URL: z.string().url("must be an absolute URL, e.g. https://fenpos.example.com").optional(),

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
