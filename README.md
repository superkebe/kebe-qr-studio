# Kebe QR Studio

A browser-based QR code scanner and generator, built by **Isiaka Kebe** (Computer Science & Engineering, The Ohio State University).

![Sample QR code](examples/ohio-state-qr.png)

## What it does

- **Read a QR code.** Drop in an image and the app decodes it in your browser. Links are shown first and only open when you click — and it refuses `javascript:` links or URLs with hidden usernames and passwords.
- **Create a QR code** from a link or text, and export it as PNG or SVG. It warns you if the ink color is too light to scan reliably.
- **Embed a small file** (up to 1 KB) directly inside the QR code. Scanning it with the app gives you the original file back.
- **Upload a file** (up to 200 MB) and get a QR code that opens a download page. Uploads need an upload code set by the site owner and expire automatically after 7 days.
- **Use an existing file link** from Google Drive, Dropbox, or anywhere else.

Everything except the upload option runs entirely in the browser. The badge in the header switches from *Local processing* to *Uploads to server* when you pick the one mode that sends data anywhere.

## How it works

The scanner draws the image onto a canvas and hands the pixels to [jsQR](https://github.com/cozmo/jsQR). If nothing is found at a normal size, it tries again at a higher resolution. The generator uses [node-qrcode](https://github.com/soldair/node-qrcode).

Small files are packed into a versioned payload (`KEBEQR:1:` plus the filename and Base64 bytes) and rebuilt into a downloadable file when scanned.

Large uploads go to a Cloudflare Worker backed by R2 storage. The browser splits the file into 10 MB chunks and sends them as a multipart upload. The Worker:

- requires an `UPLOAD_CODE` secret, compared in constant time; with no secret set, uploads are switched off, so a public deployment can't be used as free file hosting
- checks the request origin, file size, chunk sizes, and chunk order
- cleans up file names and HTML-escapes them on the download page
- stamps every file with an expiry date, returns `410 Gone` after that, and runs a daily cron job to delete expired files

| Path | Purpose |
| --- | --- |
| `src/app.mjs` | UI, image scanning, QR generation, chunked uploads |
| `src/payload.mjs` | Embedded-file format and safe-link checks |
| `worker/index.mjs` | Upload API, file pages, downloads, expiry cleanup |
| `web/` | HTML, CSS, and third-party licenses |
| `test/` | QR round-trip tests and end-to-end Worker tests |

## Run it locally

You need Node.js 22 or later.

```sh
npm ci
npm test
npm run dev
```

Open http://localhost:8000. The local server uses an emulated storage bucket, so no cloud account is needed. The upload code is `demo` unless you set `UPLOAD_CODE` in your environment.

To try it: upload `examples/ohio-state-qr.png` under **Read a QR code**, or generate a code, download the PNG, and scan it back.

## Tests

`npm test` builds the app and runs ten tests:

- **QR round trips:** generates real QR PNGs, decodes them again, and checks that URLs, Unicode text, and a full 1 KB embedded file survive unchanged.
- **Worker end to end:** runs the bundled Worker in Miniflare (a local Cloudflare runtime). It uploads a random 25 MB file in three chunks and checks that the SHA-256 of the download matches the original. It also checks that bad upload codes, cross-site requests, and oversized files are rejected, that a script-injection filename is escaped, and that expired files return 410 and get cleaned up.

## Deploy

The app runs on Cloudflare Workers with an R2 bucket. With a Cloudflare account:

```sh
npx wrangler r2 bucket create kebe-qr-studio-files
npx wrangler secret put UPLOAD_CODE
npm run deploy
```

`wrangler.toml` sets the bucket binding, a 7-day file lifetime (`FILE_TTL_DAYS`, capped at 30), and the daily cleanup schedule. For heavier public use, add a Cloudflare rate-limiting rule on `/api/upload`.

## License

ISC. See [LICENSE](LICENSE). jsQR and node-qrcode keep their own licenses in `web/vendor/`.
