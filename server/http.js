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

const ASSET_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.avif']);

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
  let refreshing = false;

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
      return send(res, 200, { ok: true, app: 'pile', version: 3, readonly: true });
    }

    if (u.pathname === '/api/library') {
      const books = store.loadBooks().map((b) => ({
        id: b.id, title: b.title, subtitle: b.subtitle, cover: b.cover,
        kind: b.kind, ready: b.ready, count: b.count,
      }));
      return send(res, 200, { ok: true, books, readonly: true });
    }

    if (u.pathname === '/api/state') {
      const b = store.findBook(bid);
      if (!b) return send(res, 200, { ok: false, configured: false, error: '没有配置任何书' });
      const common = {
        configured: true,
        has_token: store.hasToken(),
        kind: b.kind,
        book: { id: b.id, title: b.title },
        last_sync: store.loadConfig().last_sync || 0,
      };
      if (!b.ready) {
        return send(res, 200, Object.assign({}, common, {
          ok: false,
          path: b.repo || '',
          error: b.kind === 'local' ? '目录不存在' : '仓库还没克隆到本地',
        }));
      }
      if (b.kind === 'local') {
        return send(res, 200, Object.assign({}, common, {
          ok: true, path: b.repo, branch: '', remote: '', push_disabled: true,
          ahead: 0, behind: 0, dirty: [], dirty_count: 0, head: '',
        }));
      }
      const st = await git.repoState(b.repo, { fetch: false });
      return send(res, 200, Object.assign({}, common, st));
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

    // 笔记里的相对图片：按书根解析后原样回传二进制
    if (u.pathname === '/api/asset') {
      const { root } = store.bookRootOf(bid);
      if (!root) return send(res, 404, { ok: false, error: '未配置仓库' });
      const rel = qs.get('path') || '';
      const ext = path.extname(rel).toLowerCase();
      if (!ASSET_EXT.has(ext)) return send(res, 404, { ok: false, error: '不支持的文件类型' });
      const full = path.resolve(root, rel);
      const base = path.resolve(root);
      if (full !== base && !full.startsWith(base + path.sep)) {
        return send(res, 404, { ok: false, error: '文件不存在' });
      }
      let buf;
      try {
        buf = await fsp.readFile(full);
      } catch (e) {
        return send(res, 404, { ok: false, error: '文件不存在' });
      }
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': buf.length,
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      });
      return res.end(buf);
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

    // 只读模型：这里没有任何「写回远端」的入口。
    if (u.pathname === '/api/add-local') {
      const p = String(body.path || '').trim().replace(/^["']|["']$/g, '');
      if (!p) return send(res, 400, { ok: false, error: '需要目录路径' });
      const abs = store.expandPath(p);
      if (!store.isDir(abs)) return send(res, 400, { ok: false, error: '目录不存在' });
      const raw = abs.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      const base = raw.split('/').pop();
      const id = base.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '') || 'local';
      const book = store.upsertBook({
        id, title: String(body.title || '').trim() || base, subtitle: '本地目录', local: abs,
      });
      return send(res, 200, { ok: true, book, kind: 'local' });
    }

    if (u.pathname === '/api/clone') {
      const url = String(body.url || '').trim();
      const token = String(body.token || '').trim();
      if (!url) return send(res, 400, { ok: false, error: '需要仓库地址' });
      const name = url.replace(/\/+$/, '').split('/').pop().replace(/\.git$/, '') || 'notes';
      const id = name.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '') || 'notes';
      const dest = path.join(store.reposDir(), id);
      if (token) store.setToken(token);
      let r = { ok: true, path: dest };
      if (!fs.existsSync(path.join(dest, '.git'))) {
        r = await git.cloneRepo(url, dest, token || store.getToken());
      } else {
        await git.ensureNoPush(dest);
      }
      if (!r.ok) return send(res, 200, r);
      const book = store.upsertBook({
        id, title: String(body.title || '').trim() || name, subtitle: '', remote: url,
      });
      return send(res, 200, { ok: true, book, kind: 'git-managed' });
    }

    if (u.pathname === '/api/token') {
      store.setToken(String(body.token || '').trim());
      return send(res, 200, { ok: true, has_token: store.hasToken() });
    }

    // 单向更新：pull-only。push 在这个进程里根本不存在。
    if (u.pathname === '/api/refresh') {
      const bid = qs.get('book') || String(body.book || '');
      const b = store.findBook(bid);
      if (!b) return send(res, 400, { ok: false, error: '没有这本书' });
      if (!b.ready) return send(res, 400, { ok: false, error: '这本书还没准备好' });
      if (b.kind === 'local') {
        return send(res, 200, { ok: false, code: 'local', error: '本地目录书不需要更新，它就在你这台机器上' });
      }
      if (b.kind === 'git-external') {
        return send(res, 200, {
          ok: false, code: 'external',
          error: '这是你自己的仓库目录，Pile 不会碰它；要自动更新请让 Pile 克隆一份',
        });
      }
      if (refreshing) return send(res, 429, { ok: false, error: '已有更新在进行' });
      refreshing = true;
      try {
        const rep = await git.pullRepo(b.repo, { discard: !!body.discard, bookId: b.id });
        return send(res, rep.code === 'dirty' ? 409 : 200, rep);
      } finally {
        refreshing = false;
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
