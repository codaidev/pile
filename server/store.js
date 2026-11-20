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

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const expandPath = (p) => path.resolve(String(p || '').replace(/^~/, process.env.USERPROFILE || ''));

/** Pile 自己管理的仓库目录：<数据目录>\repos\<书 id> */
function reposDir() { return path.join(dataDir, 'repos'); }
function trashDir() { return path.join(dataDir, 'trash'); }

function bookKind(b, base) {
  if (!b.repo && !b.remote) return 'local';        // 只有 local：纯静态只读
  const inside = base && (base === reposDir() || base.startsWith(reposDir() + path.sep));
  return inside ? 'git-managed' : 'git-external';
}

function decorateBook(b, idx = 0) {
  const dir = String(b.dir || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const id = String(b.id || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '');
  const bookId = id || `book-${idx}`;

  // 书的根目录来源：repo（显式路径）> remote（克隆到管理目录）> local（本地目录）
  let base = '';
  if (b.repo) base = expandPath(b.repo);
  else if (b.remote) base = path.join(reposDir(), bookId);
  else if (b.local) base = expandPath(b.local);

  const kind = bookKind(b, base);
  const root = base ? (dir ? path.join(base, ...dir.split('/').filter(Boolean)) : base) : '';
  const ready = !!base && isDir(root) && (kind === 'local' ? true : isDir(path.join(base, '.git')));
  const title = b.title || (root ? path.basename(root) : '') || '未命名';

  return {
    id: bookId,
    title,
    subtitle: b.subtitle || '',
    cover: b.cover || '#4c6ef5',
    kind,                       // git-managed | git-external | local
    repo: base,                 // 实际读文件的目录（git 书是仓库根）
    dir,
    remote: b.remote || '',
    local: b.local ? expandPath(b.local) : '',
    ready,
    count: ready ? countMd(root) : 0,
  };
}

function loadBooks() {
  const raw = (readJson(booksPath(), { books: [] }).books) || [];
  let list = Array.isArray(raw) ? raw : [];
  if (!list.length) {
    const cfg = loadConfig();
    if (cfg.repo) {
      list = [{ id: 'notes', title: path.basename(cfg.repo), repo: cfg.repo, subtitle: '整仓即为一本' }];
    } else if (cfg.remote) {
      list = [{ id: 'notes', title: cfg.remote.replace(/\/+$/, '').split('/').pop().replace(/\.git$/, ''), remote: cfg.remote }];
    }
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

/** 往 books.json 里新增/覆盖一书（书架上只展示；增删仍以文件为准） */
function upsertBook(entry) {
  const doc = readJson(booksPath(), { books: [] });
  const list = Array.isArray(doc.books) ? doc.books : [];
  const id = String(entry.id || '').trim();
  if (!id) return null;
  const i = list.findIndex((b) => String(b.id) === id);
  if (i >= 0) list[i] = Object.assign({}, list[i], entry);
  else list.push(entry);
  writeJson(booksPath(), { books: list });
  return decorateBook(list.find((b) => String(b.id) === id));
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
  countMd, decorateBook, loadBooks, upsertBook, findBook, bookRootOf,
  reposDir, trashDir, isDir, expandPath,
  configPath, booksPath,
};
