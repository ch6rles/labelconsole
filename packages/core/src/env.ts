import { z } from 'zod';
import { applyDerivedDatabaseUrls } from './db/urls';

/**
 * Process-wide configuration, validated once on first access.
 * Secrets for third-party providers do NOT live here: they live in the
 * per-org credentials vault. Only platform-level keys belong in env.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** Connection string for the restricted app role. Row-level security applies. Derived from DATABASE_SUPERUSER_URL when unset (see db/urls.ts). */
  DATABASE_URL: z.string({ error: 'set DATABASE_URL, or DATABASE_SUPERUSER_URL together with SIGNING_SECRET' }).min(1),
  /** Connection string for the owner role. Used for migrations and narrow system work only. */
  DATABASE_SYSTEM_URL: z.string({ error: 'set DATABASE_SYSTEM_URL, or DATABASE_SUPERUSER_URL together with SIGNING_SECRET' }).min(1),
  REDIS_URL: z.string().default('redis://127.0.0.1:6379'),
  /** Public origin of the web app, used for links, CSRF origin checks and cookies. */
  APP_URL: z.string().url().default('http://localhost:3000'),
  /** The one label this installation runs. There is no public sign-up: the first visit sets it up, then it is closed. */
  LABEL_NAME: z.string().trim().min(1).max(120).default('River Of Styxx'),
  /** 32-byte base64 key that wraps per-org data keys (envelope encryption). */
  VAULT_MASTER_KEY: z.string().min(40),
  VAULT_MASTER_KEY_ID: z.string().default('local-v1'),
  /** HMAC secret for signed storage URLs and webhook tokens. */
  SIGNING_SECRET: z.string().min(32),
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('.storage'),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  /** Path-style bucket URLs. Defaults to on with a custom S3_ENDPOINT (MinIO, R2); set false for Railway buckets (virtual-hosted style). */
  S3_FORCE_PATH_STYLE: z
    .enum(['true', 'false', ''])
    .optional()
    .transform((v) => (v === 'true' ? true : v === 'false' ? false : undefined)),
  /** Platform default LLM key. Orgs may override with their own vault credential. */
  ANTHROPIC_API_KEY: z.string().optional(),
  /** Only for a personal or service-account key not scoped to a workspace (wrkspc_…): sent as anthropic-workspace-id. */
  ANTHROPIC_WORKSPACE_ID: z.string().regex(/^wrkspc_[A-Za-z0-9]+$/, 'must look like wrkspc_…').optional().or(z.literal('').transform(() => undefined)),
  /** Voyage AI key for semantic agent memory (embeddings), used when a label hasn't added its own. */
  VOYAGE_API_KEY: z.string().optional().or(z.literal('').transform(() => undefined)),
  /** Voyage embedding model; changing it re-embeds existing memories in the background. */
  VOYAGE_MODEL: z.string().default('voyage-4'),
  /** Platform YouTube Data API key, used when a label hasn't added its own. */
  YOUTUBE_API_KEY: z.string().optional(),
  /** Platform Apify token (TikTok, Instagram and YouTube research for agents), used when a label hasn't added its own. */
  APIFY_API_TOKEN: z.string().optional().or(z.literal('').transform(() => undefined)),
  /** Platform SpotScraper key (Spotify play counts, credits, ISRC search), used when a label hasn't added its own. */
  SPOTSCRAPER_API_KEY: z.string().optional().or(z.literal('').transform(() => undefined)),
  /** Descriptive User-Agent required by MusicBrainz and polite for every public API. */
  HTTP_USER_AGENT: z.string().default('LabelConsole/0.1 (+https://labelconsole.app)'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Seed data is only ever written when this is set and NODE_ENV is not production. */
  LC_DEV_SEED: z.string().optional(),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(8),
  /** Agent runs one worker process executes at once (they mostly wait on the model). */
  WORKER_AGENT_CONCURRENCY: z.coerce.number().int().positive().default(8),
  AGENT_CONCURRENCY_PER_ORG: z.coerce.number().int().positive().default(4),
  WORKER_HEALTH_PORT: z.coerce.number().int().default(9091),
  /** Bearer token for GET /api/metrics (Prometheus). Unset means the endpoint is off. */
  METRICS_TOKEN: z.string().min(24).optional().or(z.literal('').transform(() => undefined)),
  /** clamd for upload virus scanning; files are marked "skipped" when unset. */
  CLAMAV_HOST: z.string().optional(),
  CLAMAV_PORT: z.coerce.number().int().default(3310),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

export function env(): Env {
  if (!cached) {
    applyDerivedDatabaseUrls();
    const parsed = EnvSchema.safeParse(process.env);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ');
      throw new Error(`Invalid environment configuration:\n  ${issues}`);
    }
    cached = parsed.data;
  }
  return cached;
}

/** Test hook: forget the cached env so a test can change process.env. */
export function resetEnvCache() {
  cached = undefined;
}
