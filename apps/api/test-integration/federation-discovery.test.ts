import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { isDockerAvailable, startPostgres, stopPostgres, type IntegrationContext } from './setup.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

let ctx: IntegrationContext | null = null;
let prisma: PrismaClient;
const dockerOk = await isDockerAvailable();

const BASE_ENV: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgresql://placeholder/x',
  JWT_ACCESS_SECRET: 'a'.repeat(48),
  JWT_REFRESH_SECRET: 'b'.repeat(48),
  NODE_ENV: 'test',
} as NodeJS.ProcessEnv;

beforeAll(async () => {
  if (!dockerOk) return;
  ctx = await startPostgres();
  prisma = ctx.prisma;
  process.env['DATABASE_URL'] = ctx.databaseUrl;
}, 120_000);

afterAll(async () => {
  if (ctx) await stopPostgres(ctx);
});

describe.skipIf(!dockerOk)('.well-known/tavern-federation', () => {
  it('returns 404 when FEDERATION_ENABLED=false', async () => {
    const env = { ...BASE_ENV, DATABASE_URL: ctx!.databaseUrl };
    const app = await buildApp({ config: loadConfig(env) });
    const res = await app.inject({ method: 'GET', url: '/.well-known/tavern-federation' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('returns a valid discovery doc when enabled', async () => {
    await prisma.federationKey.deleteMany({});
    const env = {
      ...BASE_ENV,
      DATABASE_URL: ctx!.databaseUrl,
      FEDERATION_ENABLED: 'true',
      TAVERN_DATA_KEY: randomBytes(32).toString('base64'),
      PUBLIC_BASE_URL: 'https://a.example',
    } as NodeJS.ProcessEnv;
    const app = await buildApp({ config: loadConfig(env) });
    const res = await app.inject({ method: 'GET', url: '/.well-known/tavern-federation' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.instance).toBe('a.example');
    expect(body.protocolVersion).toBe('ir20/1');
    expect(body.instanceKey).toMatch(/^ed25519:/);
    expect(body.endpoints.peering).toBe('https://a.example/_federation/peering');
    await app.close();
  });
});
