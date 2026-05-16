# Plugins

Tavern can load operator-supplied JavaScript plugins at boot. A plugin
hooks into a small set of in-process events (`onMessageCreate`,
`onMemberJoin`, `onReactionAdd`) and runs alongside the API. Useful for
auto-mod glue, custom slash commands wired to your own services, or any
piece of automation you'd otherwise jam into a separate worker.

Plugins are **not sandboxed**. They run with the same trust as the
operator. The `permissions` declared in a plugin's manifest are a
least-privilege ceiling for the Tavern API helpers injected into the
plugin context — they are not a security boundary against a hostile
plugin, which could simply `require('node:fs')` and do anything else
Node can do. Only install plugins from sources you trust.

## Where plugins live

The loader scans a single directory on boot. By default that's
`plugins/` relative to the API process working directory; the
`PLUGINS_DIR` environment variable overrides it.

```
plugins/
  hello-world/
    plugin.json
    index.mjs
  another-plugin/
    plugin.json
    index.mjs
```

Each plugin lives in its own subdirectory containing a `plugin.json`
manifest and the entry ESM file the manifest points at. Lone `.mjs`
files at the top level of the plugins directory are explicitly
**refused** so legacy pre-manifest installs surface in the logs rather
than running unchecked.

## The manifest

The `plugin.json` schema is defined in
[`packages/shared/src/plugins/manifest.ts`](../packages/shared/src/plugins/manifest.ts).
A complete manifest looks like:

```json
{
  "name": "hello-world",
  "version": "0.1.0",
  "displayName": "Hello world",
  "description": "Logs every message that hits any channel.",
  "entry": "./index.mjs",
  "permissions": ["messages.read"],
  "servers": "any",
  "homepage": "https://example.com/plugins/hello-world"
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `name` | yes | `[a-z0-9-_]+`, max 80 chars. Should match the directory name. |
| `version` | yes | SemVer-shaped string, max 40 chars. |
| `displayName` | no | Friendly label for the admin UI. Max 120 chars. |
| `description` | no | One-paragraph blurb. Max 500 chars. |
| `entry` | yes | ESM file path, relative to the manifest. Max 200 chars. |
| `permissions` | no | Array of declared permission strings (see below). Max 20. |
| `servers` | no | `"any"` or an array of server IDs. V1 only supports `"any"`. |
| `homepage` | no | Optional URL surfaced in the admin UI. |

The loader rejects plugins whose manifest is missing, invalid JSON, or
fails the schema. Each rejection is logged at `warn` level — check the
API logs at boot if a plugin doesn't appear in `GET /api/plugins`.

## Available permissions

V1 ships 13 coarse-grained permissions. Each one gates a category of
Tavern API helpers; the plugin context proxy refuses calls outside the
declared set with a clear error.

| Permission | Gates |
|------------|-------|
| `messages.read` | Reading messages and listing channel history. |
| `messages.create` | Posting messages as the plugin's own bot identity. |
| `messages.delete` | Deleting messages (subject to channel/server perms). |
| `channels.read` | Listing channels in a server the plugin is installed to. |
| `channels.create` | Creating new channels. |
| `members.read` | Listing server members + reading profiles. |
| `roles.read` | Reading role definitions and per-channel overrides. |
| `reactions.add` | Adding reactions on a message. |
| `reactions.remove` | Removing reactions a plugin previously added. |
| `webhooks.create` | Provisioning outbound webhooks for the plugin's own use. |
| `dice.roll` | Triggering the dice engine (e.g. `!roll 1d20+5`). |
| `audit.read` | Reading the audit log. Use sparingly — operator-grade access. |

Plugins SHOULD declare only the permissions they actually use. Future
versions of the manifest may surface per-permission prompts at install
time; over-broad declarations will look worse to operators reviewing
your plugin.

## A minimal plugin

Drop the following two files into `plugins/hello-world/`:

```json
{
  "name": "hello-world",
  "version": "0.1.0",
  "displayName": "Hello world",
  "description": "Logs every message that hits any channel.",
  "entry": "./index.mjs",
  "permissions": ["messages.read"],
  "servers": "any"
}
```

```javascript
// plugins/hello-world/index.mjs
export function onMessageCreate(event) {
  console.log(
    `[hello-world] ${event.authorId} in ${event.channelId ?? 'DM'}: ${event.content}`,
  );
}

export function onMemberJoin(event) {
  console.log(`[hello-world] ${event.userId} joined server ${event.serverId}`);
}
```

Restart the API. The boot log should contain a `tavern.plugin.loaded`
entry naming your plugin and listing its declared permissions. Send a
message; the `console.warn` line lands in stdout.

The current hook surface is:

| Hook | Payload |
|------|---------|
| `onMessageCreate` | `{ messageId, channelId, authorId, content }` |
| `onMemberJoin` | `{ serverId, userId }` |
| `onReactionAdd` | `{ messageId, userId, emoji }` |

Each hook can be `async`; returned promises are awaited but any throw is
logged and swallowed so a buggy plugin can't block message delivery.

## Inspecting installed plugins

The admin-only `GET /api/plugins` endpoint returns the manifest list as
the loader saw it at boot — useful for sanity-checking what is actually
running. A richer admin UI is a follow-up.

## What V1 does not have

- **Sandboxed execution.** Plugins run in-process with full Node access.
  A future version may use Node's `vm` module or a worker thread for
  isolation; until then, treat plugin source the same way you'd treat
  operator code.
- **Per-server install.** The manifest's `servers` field reads `"any"`
  in V1 — every loaded plugin sees events from every server. Per-server
  install requires an `InstalledPlugin` schema and an admin UI; planned
  for a later wave.
- **Marketplace / signed manifests.** Distribution is bring-your-own.

## See also

- [`packages/shared/src/plugins/manifest.ts`](../packages/shared/src/plugins/manifest.ts) — the canonical Zod schema.
- [`apps/api/src/services/plugin-loader.ts`](../apps/api/src/services/plugin-loader.ts) — the loader and the hook dispatch helper.
