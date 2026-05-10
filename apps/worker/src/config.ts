import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  DATABASE_URL: z.string().min(1),
  CLAMAV_HOST: z.string().default('clamav'),
  CLAMAV_PORT: z.coerce.number().int().positive().default(3310),
  ALLOW_UNSCANNED_UPLOADS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  S3_ENDPOINT: z.string().default('http://minio:9000'),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY: z.string().default('tavern'),
  S3_SECRET_KEY: z.string().default('tavern-dev-secret'),
  S3_BUCKET: z.string().default('tavern-media'),
  S3_QUARANTINE_BUCKET: z.string().default('tavern-quarantine'),
  S3_USE_SSL: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
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
  return parsed.data;
}
