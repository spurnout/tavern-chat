#!/usr/bin/env node
/**
 * Apply CORS rules to the media bucket so the browser can PUT presigned
 * upload URLs directly (cross-origin from the web app to the S3 endpoint).
 *
 * When you need this: STORAGE_BACKEND=s3 in production AND the web app and
 * the bucket sit on different origins (typically the case — the web app at
 * https://chat.example.com and the bucket at https://garage.example.com).
 * Without CORS the browser's preflight to the S3 endpoint fails and uploads
 * can't even start.
 *
 * Idempotent — re-runs replace the existing CORS configuration on the
 * bucket. Safe to chain after garage-bootstrap.
 *
 *   pnpm garage:cors
 *
 * Reads from .env:
 *   ALLOWED_ORIGINS        comma-separated origins allowed to GET/HEAD/PUT
 *   S3_PUBLIC_ENDPOINT     where to apply CORS (preferred; falls back to S3_ENDPOINT)
 *   S3_ENDPOINT            internal endpoint fallback
 *   S3_REGION              AWS sig v4 region (Garage usually uses "garage")
 *   S3_ACCESS_KEY          credentials
 *   S3_SECRET_KEY          credentials
 *   S3_BUCKET              bucket name (default: tavern-media)
 *
 * Implementation note: this script does AWS sig v4 by hand rather than
 * pulling in @aws-sdk/client-s3 or aws4. The minio JS SDK we already depend
 * on does NOT expose PutBucketCors, and the signing math is ~40 lines —
 * not worth a fresh dep tree for one one-shot call.
 */

import { createHash, createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

// Read .env from the current working directory rather than the script's
// install location. This script lives in two layouts:
//   - dev: F:\code\chat\scripts\garage-cors.mjs, .env at F:\code\chat\.env
//   - prod: H:\Server\tavern\src\scripts\garage-cors.mjs, .env at
//           H:\Server\tavern\.env (two levels up — outside the src/ subtree)
// cwd-based lookup unifies both: dev users run via `pnpm garage:cors`
// (which sets cwd to the workspace root), prod users run from
// H:\Server\tavern\ where .env lives.
const ENV_PATH = path.resolve(process.cwd(), '.env');

function loadEnv() {
  // Real process env wins (so docker-compose env overrides work), .env fills
  // gaps. Same convention as the other scripts in this directory.
  const env = { ...process.env };
  if (!existsSync(ENV_PATH)) return env;
  for (const line of readFileSync(ENV_PATH, 'utf-8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    const [, k, v] = m;
    if (env[k] === undefined || env[k] === '') env[k] = v;
  }
  return env;
}

function escapeXml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildCorsXml(origins) {
  const allowed = origins
    .map((o) => `    <AllowedOrigin>${escapeXml(o)}</AllowedOrigin>`)
    .join('\n');
  // GET + HEAD: image / audio / video tags that fetch directly (the API
  // proxy at /api/_attachments doesn't need CORS, but a public-bucket
  // deployment using getPublicUrl differently would).
  // PUT: presigned upload from the web app.
  // ExposeHeader ETag: minio reads ETag from the upload response.
  return `<?xml version="1.0" encoding="UTF-8"?>
<CORSConfiguration>
  <CORSRule>
${allowed}
    <AllowedMethod>GET</AllowedMethod>
    <AllowedMethod>HEAD</AllowedMethod>
    <AllowedMethod>PUT</AllowedMethod>
    <AllowedHeader>*</AllowedHeader>
    <ExposeHeader>ETag</ExposeHeader>
    <MaxAgeSeconds>86400</MaxAgeSeconds>
  </CORSRule>
</CORSConfiguration>
`;
}

function sha256Hex(body) {
  return createHash('sha256').update(body).digest('hex');
}

function hmac(key, data) {
  return createHmac('sha256', key).update(data).digest();
}

/**
 * Sign an AWS sig v4 request and return the headers to send.
 *
 * Hand-rolled to avoid a fresh dependency for a one-shot script. The
 * algorithm has four steps: canonical request → string-to-sign → derived
 * signing key → HMAC. See
 * https://docs.aws.amazon.com/general/latest/gr/sigv4_signing.html.
 */
function awsSigV4({ method, host, pathname, query, region, service, accessKey, secretKey, body, extraHeaders = {} }) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:\-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(body);

  const headers = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...Object.fromEntries(Object.entries(extraHeaders).map(([k, v]) => [k.toLowerCase(), v])),
  };

  const sortedHeaderKeys = Object.keys(headers).sort();
  const canonicalHeaders = sortedHeaderKeys.map((k) => `${k}:${String(headers[k]).trim()}\n`).join('');
  const signedHeaders = sortedHeaderKeys.join(';');

  const canonicalRequest = [
    method,
    pathname,
    query,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = hmac('AWS4' + secretKey, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return { ...headers, authorization };
}

async function main() {
  const env = loadEnv();

  const endpointStr = env.S3_PUBLIC_ENDPOINT || env.S3_ENDPOINT;
  if (!endpointStr) {
    console.error('garage-cors: neither S3_PUBLIC_ENDPOINT nor S3_ENDPOINT is set.');
    process.exit(1);
  }
  if (!env.S3_ACCESS_KEY || !env.S3_SECRET_KEY) {
    console.error('garage-cors: S3_ACCESS_KEY and S3_SECRET_KEY must be set.');
    process.exit(1);
  }
  if (!env.ALLOWED_ORIGINS) {
    console.error('garage-cors: ALLOWED_ORIGINS must be set (comma-separated, e.g. https://chat.example.com).');
    process.exit(1);
  }

  const origins = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  if (origins.length === 0) {
    console.error('garage-cors: ALLOWED_ORIGINS resolved to no origins.');
    process.exit(1);
  }

  const bucket = env.S3_BUCKET || 'tavern-media';
  const region = env.S3_REGION || 'garage';
  const url = new URL(endpointStr);
  const body = buildCorsXml(origins);

  // ?cors= : canonical-query-string-form, key with empty value (no '&').
  const signed = awsSigV4({
    method: 'PUT',
    host: url.host,
    pathname: `/${bucket}`,
    query: 'cors=',
    region,
    service: 's3',
    accessKey: env.S3_ACCESS_KEY,
    secretKey: env.S3_SECRET_KEY,
    body,
    extraHeaders: { 'content-type': 'application/xml' },
  });

  const target = `${endpointStr.replace(/\/$/, '')}/${bucket}?cors=`;
  console.info(`garage-cors: applying CORS to ${target}`);
  console.info(`garage-cors: allowed origins: ${origins.join(', ')}`);

  // The canonical-query-string is `cors=` (key with empty value). fetch's URL
  // parsing collapses `?cors=` to `?cors` on some Node versions — we already
  // signed with `cors=`, so build the URL manually below the layer.
  const res = await fetch(target, {
    method: 'PUT',
    headers: {
      Host: signed.host,
      Authorization: signed.authorization,
      'x-amz-date': signed['x-amz-date'],
      'x-amz-content-sha256': signed['x-amz-content-sha256'],
      'content-type': 'application/xml',
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`garage-cors: PUT failed (${res.status} ${res.statusText}):\n${text}`);
    process.exit(1);
  }

  console.info('garage-cors: done.');
}

main().catch((err) => {
  console.error('garage-cors:', err?.stack ?? err);
  process.exit(1);
});
