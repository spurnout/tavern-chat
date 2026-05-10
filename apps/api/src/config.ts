import { z } from 'zod';

const envSchema = z.object({
  APP_NAME: z.string().default('Tavern'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(3001),
  PUBLIC_BASE_URL: z.string().default('http://localhost:3001'),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),

  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 15),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 24 * 30),

  ALLOWED_ORIGINS: z.string().default('http://localhost:3000'),
  ALLOW_PUBLIC_REGISTRATION: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  // Trust & safety
  TRUST_SAFETY_CORE_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  CLAMAV_HOST: z.string().default('clamav'),
  CLAMAV_PORT: z.coerce.number().int().positive().default(3310),
  ALLOW_UNSCANNED_UPLOADS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  BLOCK_EXECUTABLE_UPLOADS: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  BLOCK_ARCHIVE_UPLOADS: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  STRIP_IMAGE_METADATA: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  MAX_MESSAGE_LENGTH: z.coerce.number().int().positive().default(4000),

  // Storage (MinIO / S3)
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
  S3_PUBLIC_BASE_URL: z.string().default('http://localhost:9000/tavern-media'),

  // LiveKit
  LIVEKIT_URL: z.string().default('ws://localhost:7880'),
  LIVEKIT_API_KEY: z.string().default('devkey'),
  LIVEKIT_API_SECRET: z.string().default('devsecret-change-me'),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
