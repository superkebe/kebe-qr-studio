import QRCode from 'qrcode';
import { FILE_LIMIT, webLink, encodeFile, decodeFile } from './payload.mjs';

const $ = id => document.getElementById(id);
const status = (id, value, error = false) => {
  $(id).textContent = value;
  $(id).classList.toggle('error', error);
};
const show = (id, visible) => { $(id).hidden = !visible; };
let previewUrl, scanned, recovered, scanId = 0, mode = 'text', exportSvg;
function download(href, name) {
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  a.click();
}
function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  download(url, name);
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

async function scan(file) {
  if (!file) return;
  const id = ++scanId;
  scanned = recovered = null;
  for (const key of ['result','open','restore','copy','scanpreview']) show(key, false);
  $('open').removeAttribute('href');
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  if (file.size > 20 * 1024 * 1024) return status('scanstatus', 'Choose an image under 20 MB.', true);
  previewUrl = URL.createObjectURL(file);
  status('scanstatus', 'Reading the image…');
  const image = new Image();
  image.src = previewUrl;
  try {
    await image.decode();
    if (id !== scanId) return;
    $('scanpreview').src = previewUrl;
    show('scanpreview', true);
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', {willReadFrequently: true});
    let code;
    for (const limit of [1400, 2400]) {
      const ratio = Math.min(1, limit / Math.max(image.naturalWidth, image.naturalHeight));
      canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
      ctx.fillStyle = 'white';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
      code = window.jsQR(frame.data, frame.width, frame.height, {inversionAttempts:'attemptBoth'});
      if (code || ratio === 1) break;
    }
    if (!code) return status('scanstatus', 'No QR code found. Try a clearer image cropped around the code.', true);
    scanned = code.data;
    recovered = decodeFile(scanned);
    const url = webLink(scanned);
    $('result').textContent = recovered ? recovered.name + ' · ' + recovered.bytes.length + ' bytes' : scanned;
    show('result', true);
    show('copy', !recovered);
    show('restore', Boolean(recovered));
    if (url) $('open').href = url;
    show('open', Boolean(url));
    status('scanstatus', recovered ? 'Embedded file found.' : url ? 'Web link found. Check the address before opening.' : 'Text decoded.');
  } catch {
    if (id === scanId) status('scanstatus', 'Could not read this image. Try a PNG, JPG, or WebP file.', true);
  }
}
$('scanfile').addEventListener('change', e => { scan(e.target.files[0]); e.target.value = ''; });
for (const event of ['dragover','dragleave','drop']) {
  $('drop').addEventListener(event, e => {
    e.preventDefault();
    $('drop').classList.toggle('over', event === 'dragover');
    if (event === 'drop') scan(e.dataTransfer.files[0]);
  });
}
$('copy').onclick = async () => {
  try {
    await navigator.clipboard.writeText(scanned);
    status('scanstatus', 'Copied to clipboard.');
  } catch { status('scanstatus', 'Select the result and copy it manually.', true); }
};
$('restore').onclick = () => {
  if (recovered) saveBlob(new Blob([recovered.bytes], {type:'application/octet-stream'}), recovered.name);
};

function setMode(nextMode) {
  mode = nextMode;
  document.querySelectorAll('[data-mode]').forEach(b => {
    b.setAttribute('aria-selected', String(b.dataset.mode === mode));
  });
  const leavesBrowser = mode === 'upload';
  $('badge').textContent = leavesBrowser ? 'UPLOADS TO SERVER' : 'LOCAL PROCESSING';
  $('badge').classList.toggle('remote', leavesBrowser);
  show('filearea', mode === 'file');
  show('uploadarea', mode === 'upload');
  for (const key of ['textlabel','content','modehint']) show(key, mode === 'text' || mode === 'filelink');
  $('textlabel').textContent = mode === 'filelink' ? 'SHAREABLE FILE URL' : 'LINK OR TEXT';
  $('content').placeholder = mode === 'filelink' ? 'https://drive.google.com/…' : 'https://your-portfolio.com';
  $('modehint').textContent = mode === 'filelink'
    ? 'Paste a file link from Drive, Dropbox, or another host. People who scan it still need permission to access the file.'
    : 'Links open only when you choose to open them.';
  clearQr();
}
function clearQr() {
  exportSvg = null;
  for (const key of ['qr','png','svg','downloadlink']) show(key, false);
  show('empty', true);
  status('createstatus', '');
}
document.querySelectorAll('[data-mode]').forEach(b => { b.onclick = () => setMode(b.dataset.mode); });
async function uploadRequest(path, options) {
  const response = await fetch(path, options);
  if (response.status === 204) return;
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) throw Error(data?.error || 'Upload failed. Please try again.');
  return data;
}

async function uploadFile(file, code) {
  if (!file || !file.size || file.size > 200_000_000) {
    throw Error('Choose a nonempty file up to 200 MB.');
  }
  if (!code) throw Error('Enter the upload code for this site.');
  status('createstatus', 'Starting upload…');
  const session = await uploadRequest('/api/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Upload-Code': code },
    body: JSON.stringify({ name: file.name, size: file.size }),
  });
  const path = '/api/upload/' + session.id;
  const headers = { 'X-Upload-Id': session.uploadId, 'X-Upload-Code': code };
  try {
    const parts = [];
    for (let offset = 0; offset < file.size; offset += session.partSize) {
      const end = Math.min(file.size, offset + session.partSize);
      const part = await uploadRequest(path + '/' + (parts.length + 1), {
        method: 'PUT', headers, body: file.slice(offset, end),
      });
      parts.push(part);
      status('createstatus', 'Uploading… ' + Math.floor(100 * end / file.size) + '%');
    }
    const result = await uploadRequest(path, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(parts),
    });
    return { url: new URL(result.path, location.origin).href, expires: new Date(session.expires) };
  } catch (error) {
    await uploadRequest(path, { method: 'DELETE', headers }).catch(() => {});
    throw error;
  }
}

$('generate').onclick = async () => {
  clearQr();
  const generate = $('generate');
  generate.disabled = true;
  const tabs = document.querySelectorAll('[data-mode]');
  tabs.forEach(tab => { tab.disabled = true; });
  const currentMode = mode;
  const uploadedFile = $('uploadfile').files[0];
  const uploadCode = $('uploadcode').value.trim();
  try {
    let value = $('content').value;
    if (mode === 'file') {
      const file = $('createfile').files[0];
      if (!file) throw Error('Choose a small file first.');
      if (file.size > FILE_LIMIT) throw Error('This file is over 1 KB. Use the File link tab instead.');
      value = encodeFile(file.name, new Uint8Array(await file.arrayBuffer()));
    } else if (mode === 'filelink') {
      value = webLink(value);
      if (!value) throw Error('Enter a valid file URL starting with https:// or http://.');
    } else if (mode !== 'upload' && !value.trim()) {
      throw Error('Enter a link or some text first.');
    }
    if (mode === 'upload') value = '';
    if (new TextEncoder().encode(value).length > 2200) throw Error('This content is too long. Shorten it or use a shareable link.');
    const dark = $('color').value;
    const channels = dark.slice(1).match(/../g).map(c => parseInt(c,16)/255).map(c => c <= 0.04045 ? c/12.92 : ((c+0.055)/1.055)**2.4);
    if (1.05 / (0.2126*channels[0] + 0.7152*channels[1] + 0.0722*channels[2] + 0.05) < 4.5) throw Error('Choose a darker ink color so the code is easy to scan.');
    const options = {errorCorrectionLevel:'M', margin:4, width:Number($('size').value), color:{dark,light:'#ffffff'}};
    const uploaded = mode === 'upload' ? await uploadFile(uploadedFile, uploadCode) : null;
    const fileUrl = uploaded?.url;
    if (fileUrl) value = fileUrl;
    const svg = await QRCode.toString(value, {...options, type:'svg'});
    await QRCode.toCanvas($('qr'), value, options);
    if (currentMode !== mode) return;
    exportSvg = svg;
    show('empty', false);
    for (const key of ['qr','png','svg']) show(key, true);
    if (mode === 'upload') {
      $('downloadlink').href = fileUrl;
      show('downloadlink', true);
    }
    status('createstatus', mode === 'upload'
      ? 'QR code ready for ' + uploadedFile.name + '. The file is available until ' + uploaded.expires.toLocaleString() + '.'
      : 'Your QR code is ready.');
  } catch (e) {
    if (currentMode === mode) status('createstatus', e.message, true);
  } finally {
    generate.disabled = false;
    tabs.forEach(tab => { tab.disabled = false; });
  }
};
$('png').onclick = () => download($('qr').toDataURL('image/png'), 'kebe-qr.png');
$('svg').onclick = () => { if (exportSvg) saveBlob(new Blob([exportSvg], {type:'image/svg+xml'}), 'kebe-qr.svg'); };
