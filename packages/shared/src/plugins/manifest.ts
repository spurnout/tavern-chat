import { z } from 'zod';

/**
 * Wave 3 #47 — Plugin manifest.
 *
 * Operators package plugins as a directory containing a `plugin.json` and
 * an `entry` ESM file. The loader (apps/api/src/services/plugin-loader.ts)
 * reads the manifest, validates it against this schema, and refuses to
 * load plugins without a valid manifest. The `permissions` array declares
 * which Tavern API surfaces the plugin needs; runtime calls outside the
 * declared set throw with a clear error.
 *
 * V1 surface — extending the permission enum requires a single edit here
 * plus the corresponding gate in the loader. Currently coarse-grained
 * (whole tables); finer-grained capabilities (e.g. read-only-on-server-X)
 * are a documented follow-up.
 */

export const pluginPermissionSchema = z.enum([
  // Messages
  'messages.read',
  'messages.create',
  'messages.delete',
  // Channels
  'channels.read',
  'channels.create',
  // Members
  'members.read',
  // Roles
  'roles.read',
  // Reactions
  'reactions.add',
  'reactions.remove',
  // Webhooks
  'webhooks.create',
  // Dice
  'dice.roll',
  // Audit log
  'audit.read',
]);

export type PluginPermission = z.infer<typeof pluginPermissionSchema>;

export const pluginManifestSchema = z.object({
  /** Stable identifier; should match the directory name. */
  name: z.string().min(1).max(80).regex(/^[a-z0-9-_]+$/i, 'Letters, numbers, dashes, underscores only'),
  /** SemVer-shaped version string. */
  version: z.string().min(1).max(40),
  /** Friendly name shown to operators. */
  displayName: z.string().max(120).optional(),
  description: z.string().max(500).optional(),
  /** ESM file path, relative to the manifest. */
  entry: z.string().min(1).max(200),
  /** Tavern API surfaces this plugin will call. */
  permissions: z.array(pluginPermissionSchema).max(20).default([]),
  /**
   * Scope of where this plugin should run. `'any'` means every server;
   * a list of server IDs restricts it. V1 supports only `'any'`; per-server
   * install is a follow-up requiring an `InstalledPlugin` table.
   */
  servers: z.union([z.literal('any'), z.array(z.string()).max(50)]).default('any'),
  /** Optional contact / repo URL. Not used by the loader, surfaced in the admin UI. */
  homepage: z.string().url().optional(),
});

export type PluginManifest = z.infer<typeof pluginManifestSchema>;
