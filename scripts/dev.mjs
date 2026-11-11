import { Miniflare } from 'miniflare';

const emulator = new Miniflare({
  modules: true,
  scriptPath: 'dist/server/index.js',
  compatibilityDate: '2026-01-01',
  r2Buckets: ['BUCKET'],
  r2Persist: '.local-storage',
  port: 8000,
  host:'0.0.0.0',
  bindings: { UPLOAD_CODE: process.env.UPLOAD_CODE ?? 'demo', FILE_TTL_DAYS: '7' },
});
console.log('Kebe QR Studio is running at ' + await emulator.ready);
console.log('Upload code for this session: ' + (process.env.UPLOAD_CODE ?? 'demo'));
