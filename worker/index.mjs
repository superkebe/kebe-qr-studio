const PART_SIZE = 10_000_000;
const MAX_PARTS = 20;
const MAX_SIZE = PART_SIZE * MAX_PARTS;
const DAY_MS = 86_400_000;
const DEFAULT_TTL_DAYS = 7;

function ttlDays(env) {
  const days = Number(env.FILE_TTL_DAYS ?? DEFAULT_TTL_DAYS);
  return Number.isFinite(days) && days > 0 ? Math.min(days, 30) : DEFAULT_TTL_DAYS;
}

function isExpired(file, now = Date.now()) {
  const expires = Date.parse(file.customMetadata?.expires ?? '');
  return Number.isFinite(expires) && expires <= now;
}

// Compares the submitted upload code to the configured secret without leaking timing.
async function codeMatches(submitted, expected) {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([submitted, expected].map(value =>
    crypto.subtle.digest('SHA-256', encoder.encode(value))));
  return crypto.subtle.timingSafeEqual(a, b);
}

function json(data, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

function disposition(name, kind = 'attachment') {
  const safeName = encodeURIComponent(name.toWellFormed()).replace(/['()*]/g, char =>
    '%' + char.charCodeAt(0).toString(16).toUpperCase());
  return kind + "; filename*=UTF-8''" + safeName;
}

async function upload(request, url, env) {
  const bucket = env.BUCKET;
  if (request.headers.get('Origin') !== url.origin) return json({ error: 'Upload must come from QR Studio.' }, 403);
  if (!bucket) return json({ error: 'File storage is unavailable.' }, 503);
  // Uploads stay off unless the deployment sets an UPLOAD_CODE secret, so a public
  // deployment can't be used as free file hosting by anyone who finds the URL.
  if (!env.UPLOAD_CODE) return json({ error: 'Uploads are turned off on this deployment.' }, 503);
  if (!await codeMatches(request.headers.get('X-Upload-Code') ?? '', env.UPLOAD_CODE)) {
    return json({ error: 'That upload code is not correct.' }, 401);
  }

  if (url.pathname === '/api/upload' && request.method === 'POST') {
    const { name, size } = await request.json();
    if (!Number.isInteger(size) || size < 1 || size > MAX_SIZE || typeof name !== 'string') {
      return json({ error: 'Choose a file between 1 byte and 200 MB.' }, 400);
    }
    const id = crypto.randomUUID();
    const cleanName = Array.from(name.replace(/[/\\\u0000-\u001f\u007f]/g, '_')).slice(0, 150).join('') || 'download';
    const expires = new Date(Date.now() + ttlDays(env) * DAY_MS).toISOString();
    const session = await bucket.createMultipartUpload('files/' + id, {
      customMetadata: { filename: cleanName, expires },
      httpMetadata: { contentType: 'application/octet-stream', contentDisposition: disposition(cleanName) },
    });
    return json({ id, uploadId: session.uploadId, partSize: PART_SIZE, expires }, 201);
  }

  const route = /^\/api\/upload\/([0-9a-f-]{36})(?:\/([1-9]\d?))?$/.exec(url.pathname);
  const uploadId = request.headers.get('X-Upload-Id');
  if (!route || !uploadId) return json({ error: 'Upload session missing.' }, 404);
  const [, id, part] = route;
  const session = bucket.resumeMultipartUpload('files/' + id, uploadId);

  if (request.method === 'PUT' && part) {
    const length = Number(request.headers.get('Content-Length'));
    if (!request.body || Number(part) > MAX_PARTS || length < 1 || length > PART_SIZE || !Number.isInteger(length)) {
      return json({ error: 'Invalid upload chunk.' }, 413);
    }
    return json(await session.uploadPart(Number(part), request.body));
  }
  if (request.method === 'POST' && !part) {
    const parts = await request.json();
    if (!Array.isArray(parts) || parts.length < 1 || parts.length > MAX_PARTS ||
        parts.some((entry, i) => entry?.partNumber !== i + 1 || typeof entry.etag !== 'string')) {
      return json({ error: 'Upload chunks are incomplete.' }, 400);
    }
    await session.complete(parts);
    return json({ path: '/files/' + id });
  }
  if (request.method === 'DELETE' && !part) {
    await session.abort();
    return new Response(null, { status: 204 });
  }
  return json({ error: 'Method not allowed.' }, 405);
}

const PREVIEW_TYPES = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  txt: 'text/plain; charset=utf-8',
};

function filename(file) {
  if (file.customMetadata?.filename) return file.customMetadata.filename;
  const encoded = file.httpMetadata?.contentDisposition?.split("filename*=UTF-8''")[1];
  try { return encoded ? decodeURIComponent(encoded) : 'download'; }
  catch { return 'download'; }
}

function escapeHtml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function filePage(path, name, size, canPreview, expires) {
  const title = escapeHtml(name);
  const open = canPreview ? `<a class="button" href="${path}/open">Open file</a>` : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Kebe QR Studio</title><link rel="stylesheet" href="/style.css"></head>
<body><header><a class="brand" href="/">Kebe QR Studio</a></header>
<main><section class="panel file-page"><h1>${title}</h1>
<p>${new Intl.NumberFormat('en-US').format(size)} bytes${expires ? ' · available until ' + escapeHtml(new Date(expires).toUTCString()) : ''}</p>
<div class="actions">${open}<a class="button" href="${path}/download">Download original</a></div>
</section></main></body></html>`;
}

async function serveFile(request, [, path, action], bucket) {
  const key = path.slice(1);
  const file = action && request.method === 'GET' ? await bucket?.get(key) : await bucket?.head(key);
  const headers = new Headers({
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  if (!file) return new Response('This file could not be found. Ask the sender for a new QR code.', { status: 404, headers });
  if (isExpired(file)) {
    await bucket.delete(key);
    return new Response('This file has expired. Ask the sender for a new QR code.', { status: 410, headers });
  }
  const name = filename(file);
  const extension = name.split('.').at(-1).toLowerCase();
  const type = Object.hasOwn(PREVIEW_TYPES, extension) ? PREVIEW_TYPES[extension] : null;
  if (!action) {
    headers.set('Content-Type', 'text/html; charset=utf-8');
    return new Response(request.method === 'HEAD' ? null : filePage(path, name, file.size, Boolean(type), file.customMetadata?.expires), { headers });
  }
  const preview = action === 'open' && type;
  headers.set('Content-Type', preview ? type : 'application/octet-stream');
  headers.set('Content-Disposition', disposition(name, preview ? 'inline' : 'attachment'));
  headers.set('Content-Length', String(file.size));
  return new Response(request.method === 'HEAD' ? null : file.body, { headers });
}

// Runs on the cron schedule in wrangler.toml and removes files past their expiry.
async function deleteExpired(bucket) {
  if (!bucket) return 0;
  const now = Date.now();
  let cursor, removed = 0;
  do {
    const page = await bucket.list({ prefix: 'files/', cursor, include: ['customMetadata'] });
    const expired = page.objects.filter(file => isExpired(file, now)).map(file => file.key);
    if (expired.length) await bucket.delete(expired);
    removed += expired.length;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return removed;
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(deleteExpired(env.BUCKET));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/upload' || url.pathname.startsWith('/api/upload/')) {
        return await upload(request, url, env);
      }
      const fileRoute = /^(\/files\/[0-9a-f-]{36})(?:\/(open|download))?$/.exec(url.pathname);
      if ((request.method === 'GET' || request.method === 'HEAD') && fileRoute) {
        return await serveFile(request, fileRoute, env.BUCKET);
      }
      if (request.method === 'GET' && Object.hasOwn(assets, url.pathname)) {
        const [body, type] = assets[url.pathname];
        return new Response(body, { headers: { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff' } });
      }
      return new Response('Not found.', { status: 404 });
    } catch (error) {
      console.error('QR Studio request failed:', error.message);
      return json({ error: 'The file operation failed. Please try again.' }, 500);
    }
  },
};
