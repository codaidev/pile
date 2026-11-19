'use strict';
/**
 * 数据层：配置文件、书单、token 加密存储。
 * 与 Python 版等价，但 token 改用 Electron safeStorage（Windows 下同样是 DPAPI）。
 */
const fs = require('fs');
const path = require('path');

const MD_EXT = ['.md', '.markdown'];
const SKIP_DIRS = new Set(['.git', 'node_modules', 'site', '.cache', '__pycache__', '.github']);
const DEFAULT_CONFIG = { repo: '', token_blob: '', last_sync: 0, theme: 'auto' };

let dataDir = '';
let cryptoBox = null;   // { encrypt(plain:Buffer):Buffer, decrypt(buf:Buffer):string }

function setDataDir(dir) {
  dataDir = dir;
  fs.mkdirSync(dir, { recursive: true });
}
function getDataDir() { return dataDir; }
function setCrypto(box) { cryptoBox = box; }
function hasCrypto() { return !!cryptoBox; }

const configPath = () => path.join(dataDir, 'config.json');
const booksPath = () => path.join(dataDir, 'books.json');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, obj) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1), 'utf8');
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------- 配置
function loadConfig() {
  return Object.assign({}, DEFAULT_CONFIG, readJson(configPath(), {}));
}
function saveConfig(cfg) { writeJson(configPath(), cfg); }

// ---------------------------------------------------------------- token
function setToken(token) {
  const cfg = loadConfig();
  const plain = (token || '').trim();
  if (!plain) {
    cfg.token_blob = '';
  } else if (cryptoBox) {
    cfg.token_blob = cryptoBox.encrypt(Buffer.from(plain, 'utf8')).toString('base64');
  } else {
    // 没有 safeStorage（例如用 node 直接跑服务端做测试）时不落盘明文，只在内存里留着
    cfg.token_blob = '';
    memoryToken = plain;
  }
  saveConfig(cfg);
}

let memoryToken = '';
let tokenCache = '';

function getToken() {
  if (memoryToken) return memoryToken;
  if (tokenCache) return tokenCache;
  const blob = loadConfig().token_blob;
  if (!blob || !cryptoBox) return '';
  try {
    tokenCache = cryptoBox.decrypt(Buffer.from(blob, 'base64')) || '';
    return tokenCache;
  } catch {
    return '';
  }
}

function hasToken() { return !!(getToken() || loadConfig().token_blob); }

// ---------------------------------------------------------------- 书架
function countMd(root, cap = 999) {
  let n = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const name = e.name;
      if (name.startsWith('.') || SKIP_DIRS.has(name)) continue;
      const full = path.join(dir, name);
      if (e.isDirectory()) stack.push(full);
      else if (MD_EXT.some((x) => name.toLowerCase().endsWith(x))) {
        if (++n >= cap) return n;
      }
    }
  }
  return n;
}

function decorateBook(b, idx = 0) {
  const repo = b.repo ? path.resolve(String(b.repo).replace(/^~/, process.env.USERPROFILE || '')) : '';
  const dir = String(b.dir || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const root = repo && dir ? path.join(repo, ...dir.split('/').filter(Boolean)) : repo;
  const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
  const ready = !!repo && isDir(path.join(repo, '.git')) && isDir(root);
  const id = String(b.id || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const title = b.title || (root ? path.basename(root) : '') || '未命名';
  return {
    id: id || `book-${idx}`,
    title,
    subtitle: b.subtitle || '',
    cover: b.cover || '#4c6ef5',
    repo,
    dir,
    remote: b.remote || '',
    ready,
    count: ready ? countMd(root) : 0,
  };
}

function loadBooks() {
  const raw = (readJson(booksPath(), { books: [] }).books) || [];
  let list = Array.isArray(raw) ? raw : [];
  if (!list.length) {
    const repo = loadConfig().repo || '';
    if (repo) list = [{ id: 'notes', title: path.basename(repo), repo, subtitle: '整仓即为一本' }];
  }
  const books = [];
  const seen = new Set();
  list.forEach((b, i) => {
    const bk = decorateBook(b, i);
    if (seen.has(bk.id)) bk.id = `${bk.id}-${i}`;
    seen.add(bk.id);
    books.push(bk);
  });
  return books;
}

function findBook(bookId = '') {
  const books = loadBooks();
  if (bookId) return books.find((b) => b.id === bookId) || null;
  return books[0] || null;
}

function bookRootOf(bookId = '') {
  const b = findBook(bookId);
  if (!b || !b.ready) return { root: '', book: b };
  const root = b.dir ? path.join(b.repo, ...b.dir.split('/').filter(Boolean)) : b.repo;
  return { root, book: b };
}

module.exports = {
  MD_EXT, SKIP_DIRS, DEFAULT_CONFIG,
  setDataDir, getDataDir, setCrypto, hasCrypto,
  loadConfig, saveConfig,
  setToken, getToken, hasToken,
  countMd, decorateBook, loadBooks, findBook, bookRootOf,
  configPath, booksPath,
};
