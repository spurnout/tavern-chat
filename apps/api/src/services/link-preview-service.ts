import { prisma } from '@tavern/db';
import { ulid } from '@tavern/shared';
import { gatewayBroker } from './gateway-broker.js';

/**
 * In-process OG / oEmbed unfurl. Runs as a fire-and-forget background task
 * after a message is created — the request never blocks on it. The worker
 * variant (BullMQ delayed job) is the multi-replica successor; this version
 * is sufficient for single-replica deployments and exercises the same DB +
 * gateway-event shape.
 *
 * Constraints honoured for self-hosted safety:
 *   - Outbound HTTP gated behind `OG_FETCH_ENABLED`.
 *   - Hard timeout via AbortController so a slow site can't hang the API.
 *   - Strict size cap on the response body (256 KB).
 *   - No JS execution; we only consume the static HTML.
 *   - Best-effort robots.txt check skipped for now (would add another
 *     outbound request); operators can lock down via the per-server domain
 *     allowlist (deferred).
 */

const URL_RE = /\bhttps?:\/\/[^\s<>()\[\]]+/g;
const MAX_PER_MESSAGE = 4;
const FETCH_TIMEOUT_MS = 4_000;
const MAX_BYTES = 256 * 1024;

export interface LinkPreviewDto {
  id: string;
  messageId: string;
  url: string;
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  siteName: string | null;
  fetchedAt: string;
}

function extractUrls(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  let m: RegExpExecArray | null;
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(text)) !== null && out.length < MAX_PER_MESSAGE) {
    const url = m[0];
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

function pickMeta(html: string, property: string): string | null {
  // Match <meta property="og:..." content="..."> or name=
  const re = new RegExp(
    `<meta\\s+[^>]*?(?:property|name)\\s*=\\s*["']${property}["'][^>]*?content\\s*=\\s*["']([^"']*)["']`,
    'i',
  );
  const m = re.exec(html);
  if (m) return m[1] ?? null;
  // Fallback: content before property (some sites order the other way).
  const re2 = new RegExp(
    `<meta\\s+[^>]*?content\\s*=\\s*["']([^"']*)["'][^>]*?(?:property|name)\\s*=\\s*["']${property}["']`,
    'i',
  );
  const m2 = re2.exec(html);
  if (m2) return m2[1] ?? null;
  return null;
}

function pickTitle(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m) return null;
  return m[1]?.trim() ?? null;
}

async function fetchPreview(url: string): Promise<LinkPreviewDto | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'user-agent': 'TavernBot/1.0 (+https://github.com/)',
        accept: 'text/html, application/xhtml+xml',
      },
    });
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('html')) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) return null;
    const html = new TextDecoder('utf-8', { fatal: false }).decode(buf);

    const title = pickMeta(html, 'og:title') ?? pickTitle(html);
    const description = pickMeta(html, 'og:description') ?? pickMeta(html, 'description');
    const imageUrl = pickMeta(html, 'og:image');
    const siteName = pickMeta(html, 'og:site_name');
    if (!title && !description && !imageUrl) return null;

    return {
      id: ulid(),
      messageId: '',
      url,
      title,
      description,
      imageUrl,
      siteName,
      fetchedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Cache lookup — returns previews from the LinkPreview table that match any
 * of the URLs in `urls`. Reused across messages so a popular URL only gets
 * fetched once.
 */
async function fetchCached(urls: string[]): Promise<Map<string, LinkPreviewDto>> {
  if (urls.length === 0) return new Map();
  const TTL_MS = 24 * 60 * 60 * 1000;
  const fresh = new Date(Date.now() - TTL_MS);
  const rows = await prisma.linkPreview.findMany({
    where: { url: { in: urls }, fetchedAt: { gte: fresh } },
    orderBy: { fetchedAt: 'desc' },
  });
  const byUrl = new Map<string, LinkPreviewDto>();
  for (const r of rows) {
    if (byUrl.has(r.url)) continue;
    byUrl.set(r.url, {
      id: r.id,
      messageId: r.messageId,
      url: r.url,
      title: r.title,
      description: r.description,
      imageUrl: r.imageUrl,
      siteName: r.siteName,
      fetchedAt: r.fetchedAt.toISOString(),
    });
  }
  return byUrl;
}

/**
 * Kick off link-preview generation for a freshly-created message. Returns
 * immediately; results are persisted and published via LINK_PREVIEW_READY.
 */
export function enqueueLinkPreviews(opts: {
  messageId: string;
  channelId: string | null;
  content: string;
}): void {
  // OG fetching is opt-in via env so air-gapped self-hosters never leak
  // outbound HTTP. Read on demand rather than at module init so tests can
  // flip it without re-importing.
  if (process.env['OG_FETCH_ENABLED'] !== 'true') return;
  const urls = extractUrls(opts.content);
  if (urls.length === 0) return;
  setImmediate(() => {
    void runLinkPreviewJob(opts.messageId, opts.channelId, urls);
  });
}

async function runLinkPreviewJob(
  messageId: string,
  channelId: string | null,
  urls: string[],
): Promise<void> {
  try {
    const cached = await fetchCached(urls);
    const out: LinkPreviewDto[] = [];
    for (const url of urls) {
      const hit = cached.get(url);
      if (hit) {
        out.push({ ...hit, messageId });
        continue;
      }
      const fetched = await fetchPreview(url);
      if (!fetched) continue;
      const row = await prisma.linkPreview.create({
        data: {
          id: fetched.id,
          messageId,
          url: fetched.url,
          title: fetched.title,
          description: fetched.description,
          imageUrl: fetched.imageUrl,
          siteName: fetched.siteName,
        },
      });
      out.push({
        id: row.id,
        messageId,
        url: row.url,
        title: row.title,
        description: row.description,
        imageUrl: row.imageUrl,
        siteName: row.siteName,
        fetchedAt: row.fetchedAt.toISOString(),
      });
    }
    if (out.length === 0) return;
    gatewayBroker.publish({
      type: 'LINK_PREVIEW_READY',
      channelId: channelId ?? undefined,
      data: { messageId, previews: out },
    });
  } catch {
    // Best-effort — link previews never break the message itself.
  }
}
