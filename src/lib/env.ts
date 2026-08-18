import { z } from "zod";

/**
 * Environment is parsed once, at module load, so a misconfigured deploy fails
 * immediately with a readable message instead of throwing `undefined is not a
 * string` from somewhere deep in a request three minutes later.
 */
/**
 * Treats an empty value as absent.
 *
 * `KEY=` in a .env file becomes the empty string, not undefined — so a
 * placeholder line left blank would fail a `.min(1)` check and take the whole
 * app down at boot. A commented-out key and a blank one should behave the
 * same: the feature is off, everything else still runs.
 */
const optionalString = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().min(1).optional(),
);

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  SESSION_SECRET: z
    .string()
    .min(32, "SESSION_SECRET must be at least 32 characters"),
  /**
   * Total bytes the demo will hold before refusing uploads. Files live in
   * Postgres (see src/lib/storage), and Neon's free tier is 0.5 GB — an upload
   * limit alone does not bound the total, because nothing stops a visitor
   * uploading repeatedly.
   */
  STORAGE_TOTAL_CAP_MB: z.coerce.number().int().min(1).max(100_000).default(200),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  /**
   * Deliberately optional. Upload, list, and detail must keep working before a
   * key exists — only extraction needs it, and it fails there with a specific
   * message rather than taking the whole app down at boot.
   */
  ANTHROPIC_API_KEY: optionalString,

  /**
   * The one account the /api/auth/demo endpoint may authenticate. Narrow by
   * design: the endpoint takes no email parameter, so it cannot be pointed at
   * a real user.
   */
  DEMO_EMAIL: z.string().default("demo@trueline.app"),
  /** Set to "false" to disable one-click demo login on a real deployment. */
  DEMO_LOGIN_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),

  /**
   * Spend guards for the one endpoint that costs money. Enforced against
   * Postgres in src/lib/extraction/spend-guard.ts, so they hold across
   * serverless instances — unlike the in-memory limiter, which cannot.
   *
   * At roughly $0.02 a call, the defaults cap a public demo near $4/month.
   * These are the app's own limits; the authoritative one is the workspace
   * spend limit in the Anthropic Console.
   */
  EXTRACTION_HOURLY_CLIENT_CAP: z.coerce.number().int().min(1).max(1000).default(10),
  EXTRACTION_MONTHLY_CAP: z.coerce.number().int().min(1).max(100_000).default(200),

  /** Tuning knobs, so cost/quality can change without a code edit. */
  EXTRACTION_MODEL: z.string().default("claude-opus-5"),
  EXTRACTION_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
  EXTRACTION_MAX_TOKENS: z.coerce.number().int().min(1024).max(128_000).default(16_000),
  EXTRACTION_RETRY_MAX_TOKENS: z.coerce.number().int().min(1024).max(128_000).default(32_000),
  /** Must stay under the extract route's maxDuration (60s). */
  EXTRACTION_BUDGET_MS: z.coerce.number().int().min(5_000).max(55_000).default(50_000),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  ${i.path.join(".")}: ${i.message}`)
    .join("\n");
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const env = parsed.data;

/** Whether extraction can run at all. Everything else works without a key. */
export const hasClaudeCredentials = (): boolean => env.ANTHROPIC_API_KEY !== undefined;
