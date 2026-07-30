import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, extname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'module';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const require = createRequire(import.meta.url);
const PORT = process.env.PORT || 4567;

// Load .env.local so the API routes get DATABASE_URL / ADMIN_KEY locally,
// exactly as they do on Vercel.
try {
  const env = await readFile(join(__dirname, '.env.local'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
} catch {
  console.warn('No .env.local found — /api routes needing a database will fail.');
}

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
  });
}

/** Minimal stand-in for the Vercel function runtime, so /api behaves locally. */
async function handleApi(req, res, route) {
  const file = join(__dirname, 'api', `${route}.js`);
  if (!existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'No such API route' }));
  }

  // Re-require on every call so edits are picked up without a restart
  delete require.cache[require.resolve(file)];
  const handler = require(file);

  req.body = await readBody(req);

  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (obj) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(obj));
    return res;
  };

  try {
    await handler(req, res);
  } catch (err) {
    console.error(`api/${route} threw:`, err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Server error' }));
    }
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = decodeURIComponent(url.pathname);

  // API routes
  const apiMatch = pathname.match(/^\/api\/([A-Za-z0-9_-]+)\/?$/);
  if (apiMatch) return handleApi(req, res, apiMatch[1]);

  // Static files, with clean URLs (/admin -> admin.html) to match vercel.json
  let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
  if (!extname(rel) && existsSync(join(__dirname, `${rel}.html`))) rel += '.html';

  const filePath = join(__dirname, rel);
  const contentType = MIME_TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream';

  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

server.listen(PORT, () => {
  console.log(`Belvoir dev server: http://localhost:${PORT}`);
  console.log(`  API routes served from ./api  (${process.env.DATABASE_URL ? 'database connected' : 'NO DATABASE_URL'})`);
});
