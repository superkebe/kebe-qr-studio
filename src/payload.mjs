export const FILE_LIMIT = 1024;
const PREFIX = 'KEBEQR:1:';
export function webLink(value) {
  try {
    const url = new URL(value.trim());
    if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch {}
  return null;
}
export function encodeFile(name, bytes) {
  if (bytes.length > FILE_LIMIT) throw Error('This file is over 1 KB. Use the File link tab instead.');
  return PREFIX + JSON.stringify({name: Array.from(name).slice(0,100).join(''), data: btoa(String.fromCharCode(...bytes))});
}
export function decodeFile(value) {
  if (!value.startsWith(PREFIX)) return null;
  try {
    const { name, data } = JSON.parse(value.slice(PREFIX.length));
    if (typeof name !== 'string' || typeof data !== 'string' || data.length > 1368) return null;
    const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
    if (bytes.length > FILE_LIMIT) return null;
    return { name: name.replace(/[/\\\u0000-\u001f\u007f]/g, '_').slice(0, 200) || 'qr-file', bytes };
  } catch { return null; }
}

