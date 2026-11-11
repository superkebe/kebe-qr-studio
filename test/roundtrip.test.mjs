import test from 'node:test';
import assert from 'node:assert/strict';
import QR from 'qrcode';
import jsQR from 'jsqr';
import {PNG} from 'pngjs';
import {encodeFile, decodeFile, webLink} from '../src/payload.mjs';

async function roundTrip(value) {
  const img = PNG.sync.read(await QR.toBuffer(value, {width:512}));
  return jsQR(new Uint8ClampedArray(img.data), img.width, img.height)?.data;
}
test('reads a generated PNG and preserves its full URL', async () => {
  const url = 'https://example.com/resume.pdf?source=qr';
  assert.equal(webLink(await roundTrip(url)), url);
});
test('recovers all 1024 embedded bytes from a generated PNG', async () => {
  const bytes = Uint8Array.from({length:1024}, (_,i) => (i*31)%256);
  assert.deepEqual(decodeFile(await roundTrip(encodeFile('demo.bin',bytes))), {name:'demo.bin',bytes});
});
test('preserves Unicode text', async () => {
  const value = 'Bonjour, Isiaka — Ohio State';
  assert.equal(await roundTrip(value), value);
});
test('rejects oversized payloads, malformed files and unsafe link schemes', () => {
  assert.throws(() => encodeFile('large.txt', new Uint8Array(1025)));
  assert.equal(decodeFile('KEBEQR:1:{}'),null);
  assert.equal(webLink('javascript:alert(1)'),null);
  assert.equal(webLink('https://name:password@example.com/'),null);
});
