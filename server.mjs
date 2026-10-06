import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(__dirname, 'public')));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function extractClipId(rawUrl) {
  const url = String(rawUrl || '').trim();
  if (!url) throw Object.assign(new Error('Missing url parameter'), { status: 400 });
  if (UUID_RE.test(url)) return url;
  let m;
  if ((m = url.match(/suno\.com\/song\/([0-9a-f-]{36})/i))) return m[1];
  if ((m = url.match(/suno\.com\/s\/([^/?#]+)/i))) {
    const res = await fetch(`https://suno.com/s/${m[1]}`, { redirect: 'manual' });
    const loc = res.headers.get('location') || '';
    const lm = loc.match(/song\/([0-9a-f-]{36})/i);
    if (lm) return lm[1];
    // follow the redirect to read final URL / page
    const res2 = await fetch(`https://suno.com/s/${m[1]}`, { redirect: 'follow' });
    const fm = res2.url.match(/song\/([0-9a-f-]{36})/i);
    if (fm) return fm[1];
    const html = await res2.text();
    const hm = html.match(/song\/([0-9a-f-]{36})/i);
    if (hm) return hm[1];
    throw Object.assign(new Error('Could not resolve share link'), { status: 400 });
  }
  throw Object.assign(new Error('Unrecognized Suno URL'), { status: 400 });
}

app.get('/api/download', async (req, res) => {
  try {
    const clipId = await extractClipId(req.query.url);

    const rightsRes = await fetch('https://studio-api.prod.suno.com/api/mango/rights', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': 'https://suno.com', 'Referer': 'https://suno.com/' },
      body: JSON.stringify({ content_params: { content_id: clipId, content_type: 'clip' } }),
    });
    const rights = await rightsRes.json();
    if (!rightsRes.ok) return res.status(502).json({ error: 'Rights request failed', details: rights });

    const sha256Key = async (token) => {
      const hash = crypto.createHash('sha256').update(token, 'utf8').digest();
      return crypto.subtle.importKey('raw', hash, { name: 'AES-GCM' }, false, ['decrypt']);
    };
    const userKey = await sha256Key(rights.glt);
    const aesGcm = async (wrappedB64, aad) => {
      const wrapped = new Uint8Array(Buffer.from(wrappedB64, 'base64'));
      return new Uint8Array(await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: wrapped.slice(0, 12), additionalData: Buffer.from(aad, 'utf8') },
        userKey, wrapped.slice(12)));
    };

    const contentKey = await aesGcm(rights.key, clipId);
    const contentIv = await aesGcm(rights.iv, clipId);

    const page = await fetch(`https://suno.com/song/${clipId}`).then(r => r.text());
    const m = page.match(/https:\/\/d2lwuy8qc234o3\.cloudfront\.net[^"\\]+\.m4a/);
    const mediaUrl = m ? m[0] : `https://d2lwuy8qc234o3.cloudfront.net/1/clip/${clipId}.m4a`;

    const enc = new Uint8Array(await (await fetch(mediaUrl)).arrayBuffer());
    const key = await crypto.subtle.importKey('raw', contentKey, { name: 'AES-CTR' }, false, ['decrypt']);
    const out = new Uint8Array(enc.length);
    for (let offset = 0; offset < enc.length; offset += 16 * 4096) {
      const chunk = enc.slice(offset, Math.min(offset + 16 * 4096, enc.length));
      const counter = new Uint8Array(16); counter.set(contentIv);
      let c = BigInt(offset / 16);
      for (let i = 15; i >= 0 && c > 0n; i--, c >>= 8n) counter[i] = Number(c & 0xffn);
      out.set(new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CTR', counter, length: 128 }, key, chunk)), offset);
    }

    res.setHeader('Content-Type', 'audio/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${clipId}.m4a"`);
    res.send(Buffer.from(out));
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: err.message || 'Internal error' });
  }
});

app.listen(3000, () => console.log('listening on :3000'));
