// Upload a large asset to a GitHub release using multipart chunks.
// A single 382 MB POST to uploads.github.com silently fails (observed: empty response,
// asset stuck in state=starter for 20 min, then 404 on download). The documented reliable
// path is: POST to uploads.github.com to create an upload session, then PUT each chunk to
// the returned Location URL. This script does exactly that.
//
// Usage: node upload-release-asset.mjs <owner/repo> <releaseId> <file> <assetName> <token>
import fs from 'node:fs';
import path from 'node:path';

const [repo, releaseId, file, assetName, token] = process.argv.slice(2);
if (!repo || !releaseId || !file || !assetName || !token) {
  console.error('usage: node upload-release-asset.mjs <owner/repo> <releaseId> <file> <assetName> <token>');
  process.exit(2);
}

const size = fs.statSync(file).size;
const CHUNK = 64 * 1024 * 1024; // 64 MiB — GitHub's documented chunking unit
const total = Math.ceil(size / CHUNK);

const headers = {
  Authorization: `Bearer ${token}`,
  'User-Agent': 'dsh-release-uploader',
  Accept: 'application/vnd.github+json',
};

console.log(`file       ${path.basename(file)} (${(size / 1048576).toFixed(1)} MiB)`);
console.log(`chunks     ${total} × ${CHUNK / 1048576} MiB`);

// 1. create the upload session.
// The API validates `size` at session creation ("size must be greater than or equal to 1"),
// so the total byte count has to be declared here — an empty body is rejected with HTTP 422.
const start = await fetch(
  `https://uploads.github.com/repos/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(assetName)}`,
  {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/octet-stream' },
    body: JSON.stringify({ name: assetName, size, content_type: 'application/octet-stream' }),
  },
);
if (!start.ok) {
  console.error(`session create failed: HTTP ${start.status} ${await start.text()}`);
  process.exit(1);
}
const session = await start.json();
const location = session.url;
const assetId = session.id;
console.log(`session    id=${assetId}`);

// 2. PUT each chunk in order
const fd = fs.openSync(file, 'r');
let uploaded = 0;
try {
  for (let i = 0; i < total; i++) {
    const offset = i * CHUNK;
    const len = Math.min(CHUNK, size - offset);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, offset);

    const range = `bytes ${offset}-${offset + len - 1}/${size}`;
    let attempt = 0;
    let ok = false;
    while (attempt < 4 && !ok) {
      attempt += 1;
      try {
        const res = await fetch(location, {
          method: 'PUT',
          headers: {
            ...headers,
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(len),
            'Content-Range': range,
          },
          body: buf,
        });
        if (res.ok) {
          uploaded += len;
          const pct = ((uploaded / size) * 100).toFixed(1);
          console.log(`chunk ${String(i + 1).padStart(2)}/${total}  ${pct}%  (${(uploaded / 1048576).toFixed(1)} MiB)`);
          ok = true;
        } else {
          const body = await res.text();
          console.log(`chunk ${i + 1} attempt ${attempt}: HTTP ${res.status} ${body.slice(0, 200)}`);
        }
      } catch (err) {
        console.log(`chunk ${i + 1} attempt ${attempt}: ${err.message}`);
      }
      if (!ok) await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
    if (!ok) {
      console.error(`chunk ${i + 1} failed after retries`);
      process.exit(1);
    }
  }
} finally {
  fs.closeSync(fd);
}

// 3. verify
const check = await fetch(
  `https://api.github.com/repos/${repo}/releases/assets/${assetId}`,
  { headers },
);
const info = await check.json();
console.log(`state      ${info.state}`);
console.log(`size       ${info.size} bytes (local ${size})`);
console.log(`url        ${info.browser_download_url}`);
process.exit(info.size === size ? 0 : 1);
