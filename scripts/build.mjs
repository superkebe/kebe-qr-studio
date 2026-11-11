import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';

await mkdir('dist/server', { recursive: true });
const app = await build({
  entryPoints: ['src/app.mjs'], bundle: true, minify: true, write: false,
});
const assets = {
  '/': [await readFile('web/index.html', 'utf8'), 'text/html; charset=utf-8'],
  '/style.css': [await readFile('web/style.css', 'utf8'), 'text/css; charset=utf-8'],
  '/app.js': [app.outputFiles[0].text, 'text/javascript; charset=utf-8'],
  '/vendor/jsQR.js': [await readFile('node_modules/jsqr/dist/jsQR.js', 'utf8'), 'text/javascript; charset=utf-8'],
};
const worker = await readFile('worker/index.mjs', 'utf8');
await writeFile('dist/server/index.js', 'const assets = ' + JSON.stringify(assets) + ';\n' + worker);
