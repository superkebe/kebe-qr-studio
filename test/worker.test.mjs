// End-to-end tests for the upload Worker, run against the real bundle in a local
// Cloudflare runtime (Miniflare) with an in-memory R2 bucket. `npm test` builds first.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { Miniflare } from 'miniflare';

const ORIGIN = 'http://localhost';
const CODE = 'test-code';
let mf;

before(async () => {
  mf = new Miniflare({
    modules: true,
    scriptPath: 'dist/server/index.js',
    compatibilityDate: '2026-01-01',
    r2Buckets: ['BUCKET'],
    bindings: { UPLOAD_CODE: CODE, FILE_TTL_DAYS: '7' },
  });
  await mf.ready;
});
after(() => mf?.dispose());

const call = (path, init = {}) => mf.dispatchFetch(ORIGIN + path, {
  ...init,
  headers: { Origin: ORIGIN, 'X-Upload-Code': CODE, ...init.headers },
});

// Mirrors what the browser client does: start a session, PUT each chunk, complete.
async function uploadBytes(name, bytes) {
  const start = await call('/api/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, size: bytes.length }),
  });
  assert.equal(start.status, 201);
  const session = await start.json();
  const headers = { 'X-Upload-Id': session.uploadId };
  const parts = [];
  for (let offset = 0; offset < bytes.length; offset += session.partSize) {
    const chunk = bytes.subarray(offset, offset + session.partSize);
    const res = await call(`/api/upload/${session.id}/${parts.length + 1}`, {
      method: 'PUT', headers: { ...headers, 'Content-Length': String(chunk.length) }, body: chunk,
    });
    assert.equal(res.status, 200);
    parts.push(await res.json());
  }
  const done = await call('/api/upload/' + session.id, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(parts),
  });
  assert.equal(done.status, 200);
  return { ...session, ...(await done.json()), partCount: parts.length };
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

test('a 25 MB multipart upload downloads back byte for byte', async () => {
  const original = new Uint8Array(randomBytes(25_000_000));
  const { path, partCount } = await uploadBytes('report.pdf', original);
  assert.equal(partCount, 3, 'should be split into three 10 MB chunks');

  const res = await mf.dispatchFetch(ORIGIN + path + '/download');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Content-Disposition'), /^attachment; filename\*=UTF-8''report\.pdf$/);
  const downloaded = new Uint8Array(await res.arrayBuffer());
  assert.equal(downloaded.length, original.length);
  assert.equal(sha256(downloaded), sha256(original));
});

test('the file page shows the name escaped, the size, and the expiry', async () => {
  const { path } = await uploadBytes('<img src=x onerror=alert(1)>.txt', new TextEncoder().encode('hello'));
  const html = await (await mf.dispatchFetch(ORIGIN + path)).text();
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;.txt'));
  assert.ok(!html.includes('<img'), 'filename must not become markup');
  assert.match(html, /5 bytes · available until /);
  const open = await mf.dispatchFetch(ORIGIN + path + '/open');
  assert.equal(open.headers.get('Content-Type'), 'text/plain; charset=utf-8');
  assert.equal(await open.text(), 'hello');
});

test('uploads are refused without the right code or from another origin', async () => {
  const body = JSON.stringify({ name: 'x.txt', size: 1 });
  const wrongCode = await call('/api/upload', { method: 'POST', body, headers: { 'X-Upload-Code': 'nope' } });
  assert.equal(wrongCode.status, 401);
  const noCode = await mf.dispatchFetch(ORIGIN + '/api/upload', { method: 'POST', body, headers: { Origin: ORIGIN } });
  assert.equal(noCode.status, 401);
  const crossSite = await call('/api/upload', { method: 'POST', body, headers: { Origin: 'https://evil.example' } });
  assert.equal(crossSite.status, 403);
});

test('uploads are off entirely when no UPLOAD_CODE is configured', async () => {
  const open = new Miniflare({
    modules: true, scriptPath: 'dist/server/index.js', compatibilityDate: '2026-01-01', r2Buckets: ['BUCKET'],
  });
  try {
    const res = await open.dispatchFetch(ORIGIN + '/api/upload', {
      method: 'POST', headers: { Origin: ORIGIN }, body: JSON.stringify({ name: 'x', size: 1 }),
    });
    assert.equal(res.status, 503);
  } finally { await open.dispose(); }
});

test('oversized uploads are rejected', async () => {
  const tooBig = await call('/api/upload', {
    method: 'POST', body: JSON.stringify({ name: 'big.bin', size: 200_000_001 }),
  });
  assert.equal(tooBig.status, 400);
});

test('expired files return 410 and the daily cleanup deletes them', async () => {
  const bucket = await mf.getR2Bucket('BUCKET');
  const past = new Date(Date.now() - 1000).toISOString();
  const id = '00000000-0000-4000-8000-000000000001';
  const id2 = '00000000-0000-4000-8000-000000000002';
  await bucket.put('files/' + id, 'old', { customMetadata: { filename: 'old.txt', expires: past } });
  await bucket.put('files/' + id2, 'old', { customMetadata: { filename: 'old2.txt', expires: past } });

  const res = await mf.dispatchFetch(`${ORIGIN}/files/${id}/download`);
  assert.equal(res.status, 410);
  assert.equal(await bucket.head('files/' + id), null, 'visiting an expired file deletes it');

  const worker = await mf.getWorker();
  await worker.scheduled({ cron: '17 4 * * *' });
  assert.equal(await bucket.head('files/' + id2), null, 'cron removes expired files');
});
