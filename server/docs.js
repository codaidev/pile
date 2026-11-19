'use strict';
/**
 * 文档层：文件树、单篇读取、全文搜索（只扫 Markdown）。
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { MD_EXT, SKIP_DIRS } = require('./store');

const isMd = (name) => MD_EXT.some((x) => name.toLowerCase().endsWith(x));
const skipName = (name) => name.startsWith('.') || SKIP_DIRS.has(name);

/** 文件树：根目录 README/index 最前，然后目录，然后文件（目录内 index.md 优先） */
async function buildTree(root) {
  async function walk(dir, rel) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return []; }

    const items = entries
      .filter((e) => !skipName(e.name))
      .map((e) => ({ name: e.name, isDir: e.isDirectory(), low: e.name.toLowerCase() }));

    items.sort((a, b) => {
      const rank = (it) => {
        if (!rel && (it.low === 'readme.md' || it.low === 'index.md')) return [0, 0, it.low];
        if (it.isDir) return [1, 0, it.low];
        return [2, it.low === 'index.md' ? 0 : 1, it.low];
      };
      const ra = rank(a); const rb = rank(b);
      for (let i = 0; i < 3; i++) {
        if (ra[i] < rb[i]) return -1;
        if (ra[i] > rb[i]) return 1;
      }
      return 0;
    });

    const out = [];
    for (const it of items) {
      const full = path.join(dir, it.name);
      const relPath = rel ? `${rel}/${it.name}` : it.name;
      if (it.isDir) {
        const children = await walk(full, relPath);
        if (children.length) out.push({ type: 'dir', name: it.name, path: relPath, children });
      } else if (isMd(it.name)) {
        out.push({ type: 'file', name: it.name, path: relPath });
      }
    }
    return out;
  }
  return walk(root, '');
}

/** 取单篇：去掉 YAML front-matter，返回 markdown + meta */
async function readDoc(root, relPath) {
  const rel = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const full = path.resolve(root, rel);
  const base = path.resolve(root);
  if (!(full === base || full.startsWith(base + path.sep))) {
    return { ok: false, error: '文件不存在' };
  }
  let text;
  try {
    const st = await fsp.stat(full);
    if (!st.isFile()) return { ok: false, error: '文件不存在' };
    text = await fsp.readFile(full, 'utf8');
  } catch {
    return { ok: false, error: '文件不存在' };
  }

  const meta = {};
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const idx = line.indexOf(':');
      if (idx < 0) continue;
      const k = line.slice(0, idx).trim();
      const v = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
      if (k) meta[k] = v;
    }
    text = text.slice(m[0].length);
  }
  return { ok: true, path: rel, markdown: text, meta };
}

/** 把一行 Markdown 压成便于阅读的纯文本 */
function cleanSnippet(line) {
  let s = String(line).trim();
  s = s.replace(/^#{1,6}\s*/, '');
  s = s.replace(/^>\s*/, '');
  s = s.replace(/^[-*+]\s+/, '');
  s = s.replace(/\|/g, ' ');
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  s = s.replace(/\*\*|__|`/g, '');
  s = s.replace(/\s{2,}/g, ' ');
  return s.trim();
}

async function listMdFiles(root) {
  const out = [];
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    const dir = rel ? path.join(root, ...rel.split('/')) : root;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (skipName(e.name)) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) stack.push(childRel);
      else if (isMd(e.name)) out.push(childRel);
    }
  }
  return out;
}

/** 全文搜索：逐行子串匹配，命中位置前后取窗口 */
async function search(root, query, limit = 60) {
  const q = String(query || '').trim().toLowerCase();
  if (q.length < 2) return [];
  const files = await listMdFiles(root);
  const hits = [];
  for (const rel of files) {
    let text;
    try { text = await fsp.readFile(path.join(root, ...rel.split('/')), 'utf8'); } catch { continue; }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].toLowerCase().includes(q)) continue;
      const clean = cleanSnippet(lines[i]);
      let p = clean.toLowerCase().indexOf(q);
      if (p < 0) p = 0;
      const start = Math.max(0, p - 36);
      let snippet = clean.slice(start, start + 150);
      if (start) snippet = `…${snippet}`;
      if (start + 150 < clean.length) snippet += '…';
      hits.push({ path: rel, line: i + 1, text: snippet });
      if (hits.length >= limit) return hits;
    }
  }
  return hits;
}

module.exports = { buildTree, readDoc, cleanSnippet, search, listMdFiles, isMd };
