import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { loadConfig } from '../src/config.js';

const BASE_ENV = {
  DATABASE_URL: 'postgresql://localhost/x',
  JWT_ACCESS_SECRET: 'a'.repeat(48),
  JWT_REFRESH_SECRET: 'b'.repeat(48),
};

describe('config — federation flags', () => {
  it('defaults FEDERATION_ENABLED to false', () => {
    const cfg = loadConfig({ ...BASE_ENV } as NodeJS.ProcessEnv);
    expect(cfg.FEDERATION_ENABLED).toBe(false);
  });

  it('parses FEDERATION_ENABLED=true with TAVERN_DATA_KEY in dev', () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      FEDERATION_ENABLED: 'true',
      TAVERN_DATA_KEY: randomBytes(32).toString('base64'),
    } as NodeJS.ProcessEnv);
    expect(cfg.FEDERATION_ENABLED).toBe(true);
    expect(cfg.TAVERN_DATA_KEY).toBeDefined();
  });

  it('production: refuses FEDERATION_ENABLED=true without TAVERN_DATA_KEY', () => {
    expect(() =>
      loadConfig({
        ...BASE_ENV,
        NODE_ENV: 'production',
        FEDERATION_ENABLED: 'true',
      } as NodeJS.ProcessEnv),
    ).toThrow(/TAVERN_DATA_KEY/);
  });

  it('production: refuses a malformed TAVERN_DATA_KEY', () => {
    expect(() =>
      loadConfig({
        ...BASE_ENV,
        NODE_ENV: 'production',
        FEDERATION_ENABLED: 'true',
        TAVERN_DATA_KEY: 'not-base64-32-bytes',
      } as NodeJS.ProcessEnv),
    ).toThrow(/TAVERN_DATA_KEY/);
  });

  // P5-11 — per-instance DM federation opt-out.
  it('defaults FEDERATION_DMS_ENABLED to true', () => {
    const cfg = loadConfig({ ...BASE_ENV } as NodeJS.ProcessEnv);
    expect(cfg.FEDERATION_DMS_ENABLED).toBe(true);
  });

  it('parses FEDERATION_DMS_ENABLED=false', () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      FEDERATION_DMS_ENABLED: 'false',
    } as NodeJS.ProcessEnv);
    expect(cfg.FEDERATION_DMS_ENABLED).toBe(false);
  });
});
