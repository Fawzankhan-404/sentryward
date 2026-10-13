import { z } from "zod";

// Docker Compose passes an unset variable as "", which means "not configured".
const optionalString = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  CLIENT_ORIGIN: z.string().url().default("http://localhost:5173"),
  ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, "ENCRYPTION_KEY must be 32 bytes of hex (64 characters)"),
  // GitHub App. All optional: without them GitHub connections are unavailable.
  GITHUB_HOST: z.string().default("github.com"),
  GITHUB_APP_ID: z.string().optional(),
  GITHUB_APP_SLUG: z.string().optional(),
  // PEM; a single-line value with literal \n escapes (as .env files need) is accepted.
  GITHUB_APP_PRIVATE_KEY: z
    .string()
    .optional()
    .transform((key) => key?.replace(/\\n/g, "\n")),
  GITHUB_APP_CLIENT_ID: z.string().optional(),
  GITHUB_APP_CLIENT_SECRET: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().optional(),
  // Where forges can reach this API, for the webhook URL registered on GitLab.
  API_PUBLIC_URL: z.string().url().default("http://localhost:4000"),
  // Server-wide model keys, used when the repository owner has not stored one.
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().optional(),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2000),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(2),
  // Running reviews one workspace may have at once, so one busy team cannot
  // take every worker slot. Named from before workspaces existed.
  WORKER_USER_CONCURRENCY: z.coerce.number().int().positive().default(2),
  WORKER_LOCK_TIMEOUT_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
  WORKER_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  // Who may create an account: anyone, only holders of an invite link, or
  // nobody. The first account on an empty install is always allowed.
  REGISTRATION_MODE: z.enum(["open", "invite", "closed"]).default("open"),
  // Optional mail transport for invites, e.g. smtp://user:pass@host:587. Without
  // it invites are still created and their link is shown to copy.
  SMTP_URL: optionalString(z.string().url()),
  MAIL_FROM: optionalString(z.string()),
  // The built client, served by the API in the production image so the
  // dashboard and API share one origin. Unset in development, where Vite serves it.
  STATIC_DIR: optionalString(z.string()),
  // Express "trust proxy": a hop count, or true/false. Behind a reverse proxy
  // req.ip is otherwise the proxy's address, so IP rate limits would put every
  // client in one bucket.
  TRUST_PROXY: optionalString(
    z.union([
      z.enum(["true", "false"]).transform((value) => value === "true"),
      z.coerce.number().int().nonnegative(),
    ]),
  ),
});

const parsedEnvSchema = envSchema.refine((data) => !data.SMTP_URL || data.MAIL_FROM, {
  message: "MAIL_FROM is required when SMTP_URL is set",
  path: ["MAIL_FROM"],
});

export const env = parsedEnvSchema.parse(process.env);
