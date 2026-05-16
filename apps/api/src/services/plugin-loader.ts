import path from 'node:path';
import fs from 'node:fs/promises';
import url from 'node:url';
import type { FastifyBaseLogger } from 'fastify';
import { pluginManifestSchema, type PluginManifest } from '@tavern/shared';

/**
 * Wave 3 #47 — Plugin loader with manifests.
 *
 * Each plugin lives in `plugins/<plugin-name>/` with a `plugin.json` next to
 * its entry ESM file. The loader validates the manifest, refuses to load
 * plugins that lack one or fail validation, and exposes the manifest list
 * to the admin UI via `listLoadedPlugins()`.
 *
 * Plugins still run in the API process with the same trust as the operator —
 * there is no VM-style sandbox. The manifest declared `permissions` are a
 * least-privilege ceiling for the plugin context API (helpers the loader
 * injects); they aren't a security boundary against malicious code, which
 * could just `require('node:fs')` and do whatever it wants. Document this
 * prominently in `docs/plugins.md`.
 */

export interface PluginHooks {
  onMessageCreate?: (event: {
    messageId: string;
    channelId: string | null;
    authorId: string;
    content: string;
  }) => void | Promise<void>;
  onMemberJoin?: (event: { serverId: string; userId: string }) => void | Promise<void>;
  onReactionAdd?: (event: {
    messageId: string;
    userId: string;
    emoji: string;
  }) => void | Promise<void>;
}

interface LoadedPlugin {
  manifest: PluginManifest;
  hooks: PluginHooks;
  directory: string;
}

const plugins: LoadedPlugin[] = [];

export function pluginsLoaded(): number {
  return plugins.length;
}

export function listLoadedPlugins(): PluginManifest[] {
  return plugins.map((p) => p.manifest);
}

/**
 * Scans `dir` for plugin directories. Each subdirectory containing a valid
 * `plugin.json` is loaded; anything else is logged and skipped. Lone .mjs
 * files (the pre-manifest convention) are explicitly refused so legacy
 * installs surface in logs rather than running unchecked.
 */
export async function loadPluginsFrom(dir: string, log: FastifyBaseLogger): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const candidate = path.join(dir, name);
    let stat;
    try {
      stat = await fs.stat(candidate);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      await loadPluginDirectory(candidate, log);
    } else if (/\.mjs$/.test(name)) {
      log.warn(
        { plugin: name },
        'tavern.plugin.skipped_no_manifest: lone .mjs files are no longer supported. Wrap the plugin in a directory with plugin.json',
      );
    }
  }
}

async function loadPluginDirectory(
  directory: string,
  log: FastifyBaseLogger,
): Promise<void> {
  const manifestPath = path.join(directory, 'plugin.json');
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, 'utf-8');
  } catch {
    log.warn({ directory }, 'tavern.plugin.no_manifest');
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.warn(
      { directory, err: err instanceof Error ? err.message : String(err) },
      'tavern.plugin.bad_manifest_json',
    );
    return;
  }
  const result = pluginManifestSchema.safeParse(parsed);
  if (!result.success) {
    log.warn(
      { directory, issues: result.error.issues },
      'tavern.plugin.bad_manifest',
    );
    return;
  }
  const manifest = result.data;
  const entryPath = path.join(directory, manifest.entry);
  try {
    const mod = (await import(url.pathToFileURL(entryPath).href)) as PluginHooks;
    plugins.push({ manifest, hooks: mod, directory });
    log.info(
      { plugin: manifest.name, version: manifest.version, permissions: manifest.permissions },
      'tavern.plugin.loaded',
    );
  } catch (err) {
    log.warn(
      { plugin: manifest.name, err: err instanceof Error ? err.message : String(err) },
      'tavern.plugin.load_failed',
    );
  }
}

export async function dispatchHook<K extends keyof PluginHooks>(
  name: K,
  ...args: Parameters<NonNullable<PluginHooks[K]>>
): Promise<void> {
  await Promise.all(
    plugins.map(async (entry) => {
      const fn = entry.hooks[name] as ((...a: unknown[]) => unknown) | undefined;
      if (!fn) return;
      try {
        await fn(...(args as unknown[]));
      } catch (err) {
        console.warn(`[plugin:${entry.manifest.name}] ${String(name)} threw`, err);
      }
    }),
  );
}
