'use strict';
/**
 * HTTP 层：与 Python 版路由逐一对应，前端 app.js 无需任何改动。
 */
const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const path = require('path');
const store = require('./store');
const docs = require('./docs');
const git = require('./git');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

const CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
].join('; ');

function send(res, code, body, ctype = 'application/json; charset=utf-8') {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(
    typeof body === 'string' ? body : JSON.stringify(body),
    'utf8'
  );
  const headers = {
    'Content-Type': ctype,
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };
  if (String(ctype).includes('text/html')) headers['Content-Security-Policy'] = CSP;
  res.writeHead(code, headers);
  res.end(data);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { req.destroy(); resolve({}); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

function createServer({ staticDir }) {
  let syncing = false;

  async function serveStatic(res, urlPath) {
    const rel = urlPath.replace(/^\/+/, '') || 'index.html';
    const full = path.resolve(staticDir, rel);
    const base = path.resolve(staticDir);
    if (!(full === base || full.startsWith(base + path.sep))) return false;
    let st;
    try { st = await fsp.stat(full); } catch { return false; }
    if (!st.isFile()) return false;
    const data = await fsp.readFile(full);
    send(res, 200, data, MIME[path.extname(full).toLowerCase()] || 'application/octet-stream');
    return true;
  }

  async function handleGet(req, res, u, qs) {
    const bid = qs.get('book') || '';

    if (u.pathname === '/api/ping') {
      return send(res, 200, { ok: true, app: 'pile', version: 2 });
    }

    if (u.pathname === '/api/library') {
      return send(res, 200, {
        ok: true,
        books: store.loadBooks().map((b) => ({
          id: b.id, title: b.title, subtitle: b.subtitle, cover: b.cover,
          remote: b.remote, ready: b.ready, count: b.count,
        })),
      });
    }

    if (u.pathname === '/api/state') {
      const b = store.findBook(bid);
      const p = b ? b.repo : store.loadConfig().repo || '';
      if (!p) return send(res, 200, { ok: false, configured: false });
      const st = await git.repoState(p);
      st.configured = true;
      st.has_token = store.hasToken();
      st.book = b ? { id: b.id, title: b.title } : null;
      return send(res, 200, st);
    }

    if (u.pathname === '/api/tree') {
      const { root, book } = store.bookRootOf(bid);
      if (!root) {
        const msg = book ? '这本书还没准备好（仓库未克隆或目录不存在）' : '没有配置任何书';
        return send(res, 200, { ok: false, tree: [], error: msg });
      }
      return send(res, 200, { ok: true, book: book.id, tree: await docs.buildTree(root) });
    }

    if (u.pathname === '/api/doc') {
      const { root } = store.bookRootOf(bid);
      if (!root) return send(res, 200, { ok: false, error: '未配置仓库' });
      return send(res, 200, await docs.readDoc(root, qs.get('path') || ''));
    }

    if (u.pathname === '/api/search') {
      const { root } = store.bookRootOf(bid);
      const q = qs.get('q') || '';
      return send(res, 200, { ok: true, hits: root ? await docs.search(root, q) : [] });
    }

    if (u.pathname.startsWith('/api/')) {
      return send(res, 404, { ok: false, error: 'not found' });
    }

    if (await serveStatic(res, u.pathname)) return;
    // SPA 回退：前端路由（/read/...）与无扩展名路径都交给 index.html
    if (u.pathname.startsWith('/read/') || !path.extname(u.pathname)) {
      if (await serveStatic(res, '/index.html')) return;
    }
    return send(res, 404, { ok: false, error: 'not found' });
  }

  async function handlePost(req, res, u, qs) {
    const body = await readBody(req);

    if (u.pathname === '/api/setup') {
      const p = String(body.path || '').trim();
      let isDir = false;
      try { isDir = fs.statSync(p).isDirectory(); } catch { isDir = false; }
      if (!isDir) return send(res, 400, { ok: false, error: '目录不存在' });
      const cfg = store.loadConfig();
      cfg.repo = path.resolve(p);
      store.saveConfig(cfg);
      if (body.token) store.setToken(body.token);
      return send(res, 200, await git.repoState(cfg.repo));
    }

    if (u.pathname === '/api/clone') {
      const url = String(body.url || '').trim();
      let dest = String(body.dest || '').trim();
      const token = String(body.token || '').trim();
      if (!url) return send(res, 400, { ok: false, error: '需要仓库地址' });
      if (!dest) {
        const name = url.replace(/\/+$/, '').split('/').pop().replace(/\.git$/, '') || 'notes';
        dest = path.join(process.env.USERPROFILE || require('os').homedir(), 'notes', name);
      }
      if (token) store.setToken(token);
      let res2;
      if (fs.existsSync(path.join(dest, '.git'))) {
        res2 = { ok: true, path: dest };
      } else {
        res2 = await git.cloneRepo(url, dest, token || store.getToken());
      }
      if (!res2.ok) return send(res, 200, res2);
      const cfg = store.loadConfig();
      cfg.repo = path.resolve(dest);
      store.saveConfig(cfg);
      return send(res, 200, await git.repoState(cfg.repo));
    }

    if (u.pathname === '/api/token') {
      store.setToken(String(body.token || '').trim());
      return send(res, 200, { ok: true, has_token: store.hasToken() });
    }

    if (u.pathname === '/api/sync') {
      const bid = qs.get('book') || String(body.book || '');
      const b = store.findBook(bid);
      const p = b ? b.repo : store.loadConfig().repo || '';
      if (!p) return send(res, 400, { ok: false, error: '未配置仓库' });
      if (syncing) return send(res, 429, { ok: false, error: '已有同步在进行' });
      syncing = true;
      try {
        return send(res, 200, await git.syncRepo(p));
      } finally {
        syncing = false;
      }
    }

    return send(res, 404, { ok: false, error: 'not found' });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, 'http://127.0.0.1');
      const qs = u.searchParams;
      if (req.method === 'GET' || req.method === 'HEAD') return await handleGet(req, res, u, qs);
      if (req.method === 'POST') return await handlePost(req, res, u, qs);
      return send(res, 405, { ok: false, error: 'method not allowed' });
    } catch (e) {
      try { send(res, 500, { ok: false, error: String((e && e.message) || e) }); } catch { /* ignore */ }
    }
  });

  return server;
}

module.exports = { createServer, MIME };
