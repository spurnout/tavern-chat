import { z } from 'zod';

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v === '' ? undefined : v));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** When unset, the worker exits cleanly — the api runs the pipeline in-process. */
  REDIS_URL: optionalString,
  DATABASE_URL: z.string().min(1),

  /** ClamAV is optional; when unset, scanning is skipped (per ALLOW_UNSCANNED_UPLOADS). */
  CLAMAV_HOST: optionalString,
  CLAMAV_PORT: z.coerce.number().int().positive().default(3310),
  ALLOW_UNSCANNED_UPLOADS: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  STORAGE_BACKEND: z.enum(['local', 's3']).default('local'),
  LOCAL_STORAGE_DIR: z.string().default('./data/storage'),

  /** API base URL — used by the local backend to mint public URLs. */
  API_BASE_URL: z.string().default('http://localhost:3001'),

  /** Used only when STORAGE_BACKEND=s3. */
  S3_ENDPOINT: optionalString,
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY: optionalString,
  S3_SECRET_KEY: optionalString,
  S3_BUCKET: z.string().default('tavern-media'),
  S3_QUARANTINE_BUCKET: z.string().default('tavern-quarantine'),
  S3_USE_SSL: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  S3_PUBLIC_BASE_URL: z.string().default('http://localhost:9000/tavern-media'),
});

export type WorkerConfig = z.infer<typeof envSchema>;

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    const hint = `\n\nDid you copy .env.example to .env at the workspace root?\n  cp .env.example .env`;
    throw new Error(`Invalid worker environment:\n${issues}${hint}`);
  }
  const cfg = parsed.data;
  if (cfg.STORAGE_BACKEND === 's3') {
    const missing: string[] = [];
    if (!cfg.S3_ENDPOINT) missing.push('S3_ENDPOINT');
    if (!cfg.S3_ACCESS_KEY) missing.push('S3_ACCESS_KEY');
    if (!cfg.S3_SECRET_KEY) missing.push('S3_SECRET_KEY');
    if (missing.length > 0) {
      throw new Error(
        `STORAGE_BACKEND=s3 but the following are missing: ${missing.join(', ')}.`,
      );
    }
  }
  return cfg;
}
