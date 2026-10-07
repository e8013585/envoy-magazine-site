// Local development server for the Envoy site.
//
//   node server.mjs            -> http://localhost:4173
//
// Serves ./docs exactly as GitHub Pages would, and adds a small write API
// (only reachable from this machine) so the admin panel can save content
// straight to disk while you work locally. On GitHub Pages that API does not
// exist and the admin panel publishes through the GitHub API instead.
import http from 'node:http';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'docs');
const port = Number(process.env.PORT) || 4173;
const host = '127.0.0.1';

const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

// Only these locations under docs/ may be written by the admin panel.
const WRITABLE = [/^data\/content\.json$/, /^data\/admin\.json$/, /^assets\/uploads\/[\w\-./]+\.(jpe?g|png|webp|gif|svg)$/i];

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req, limit = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Payload too large')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handleApi(req, res, url) {
  // Refuse anything that did not come from a page served by this server.
  const origin = req.headers.origin;
  if (origin && origin !== `http://localhost:${port}` && origin !== `http://${host}:${port}`) {
    return send(res, 403, { error: 'Forbidden origin' });
  }
  if (url.pathname === '/__local/ping') return send(res, 200, { ok: true, mode: 'local' });
  if (url.pathname === '/__local/write' && req.method === 'POST') {
    try {
      const { path: rel, content, encoding } = JSON.parse((await readBody(req)).toString('utf8'));
      const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
      if (clean.includes('..') || !WRITABLE.some((re) => re.test(clean))) {
        return send(res, 400, { error: `Path not writable: ${clean}` });
      }
      const target = path.join(root, clean);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, encoding === 'base64' ? Buffer.from(content, 'base64') : String(content));
      console.log(`saved ${clean}`);
      return send(res, 200, { ok: true, path: clean });
    } catch (err) {
      return send(res, 500, { error: err.message });
    }
  }
  return send(res, 404, { error: 'Not found' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith('/__local/')) return handleApi(req, res, url);

  let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  if (rel.includes('..')) return send(res, 400, 'Bad path', 'text/plain');
  let file = path.join(root, rel);
  try {
    const st = await stat(file);
    if (st.isDirectory()) {
      // Match GitHub Pages: /admin -> /admin/ so relative URLs resolve the same way.
      if (!url.pathname.endsWith('/')) {
        res.writeHead(301, { Location: url.pathname + '/' + url.search });
        return res.end();
      }
      file = path.join(file, 'index.html');
    }
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch {
    const notFound = await readFile(path.join(root, '404.html')).catch(() => 'Not found');
    send(res, 404, notFound, 'text/html; charset=utf-8');
  }
});

server.listen(port, host, () => {
  console.log(`Envoy site:   http://localhost:${port}/`);
  console.log(`Admin panel:  http://localhost:${port}/admin/`);
});
