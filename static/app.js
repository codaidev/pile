/* Pile · 前端逻辑（只读）
   视图：书架（/）→ 阅读（/read/<book>/<path>）
   书架数据来自 books.json，由 /api/library 提供。
   Pile 只会从远端「拉取」：没有提交、没有推送，界面里也不存在上传入口。 */

const $ = (sel) => document.querySelector(sel);
const el = {
  shelfView: $('#shelf-view'), readerView: $('#reader-view'),
  shelfGrid: $('#shelf-grid'), shelfCount: $('#shelf-count'),
  readerTitle: $('#reader-title'),
  tree: $('#tree'), article: $('#article'), content: $('#content'),
  chip: $('#repo-chip'), status: $('#sync-status'), toc: $('#toc'),
  searchOverlay: $('#search-overlay'), searchInput: $('#search-input'),
  searchResults: $('#search-results'), searchMeta: $('#search-meta'),
  setupOverlay: $('#setup-overlay'), reportOverlay: $('#report-overlay'),
  discardOverlay: $('#discard-overlay'), discardList: $('#discard-list'),
};

const state = {
  books: [],
  bookId: '',
  book: null,
  configured: false,
  tree: [],
  current: null,
  repoPath: '',
  query: '',
};

/* ------------------------------------------------ 工具 */
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, opts) {
  const r = await fetch(path, opts);
  return r.json();
}

const post = (path, body) => api(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body || {}),
});

/* 给请求带上当前书 */
function withBook(url) {
  if (!state.bookId) return url;
  return url + (url.includes('?') ? '&' : '?') + 'book=' + encodeURIComponent(state.bookId);
}

/* ------------------------------------------------ 主题 */
function applyTheme(t) {
  const forced = new URLSearchParams(location.search).get('theme');
  if (forced === 'dark' || forced === 'light') {
    document.documentElement.dataset.theme = forced;
    return; // 临时预览，不写进 localStorage
  }
  if (t === 'auto') {
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  } else {
    document.documentElement.dataset.theme = t;
  }
  localStorage.setItem('np:theme', t);
}

function toggleTheme() {
  const cur = document.documentElement.dataset.theme;
  applyTheme(cur === 'dark' ? 'light' : 'dark');
}

/* ------------------------------------------------ 路由 */
function parseRoute() {
  const m = location.pathname.match(/^\/read\/([^/]+)(?:\/(.*))?$/);
  if (!m) return null;
  const raw = m[2] || '';
  return { book: decodeURIComponent(m[1]), path: raw ? decodeURIComponent(raw) : '' };
}

function readUrl(bookId, path) {
  const segs = String(path).split('/').map(encodeURIComponent).join('/');
  return `/read/${encodeURIComponent(bookId)}/${segs}`;
}

function go(url, mode = 'push') {
  if (mode === 'push') history.pushState(null, '', url);
  else history.replaceState(null, '', url);
  return route();
}

async function route() {
  const r = parseRoute();
  if (r) return openBook(r.book, r.path, 'replace');
  return showShelf();
}

async function showShelf() {
  state.bookId = '';
  state.book = null;
  state.configured = false;
  state.current = null;
  el.readerView.hidden = true;
  el.shelfView.hidden = false;
  document.body.className = 'view-shelf';
  document.title = '我的书架 · 笔记';
  el.shelfGrid.setAttribute('aria-busy', 'true');
  await loadLibrary();
  renderShelf();
  el.shelfGrid.removeAttribute('aria-busy');
}

async function loadLibrary() {
  const res = await api('/api/library');
  state.books = res.ok ? (res.books || []) : [];
  return state.books;
}

function renderShelf() {
  const grid = el.shelfGrid;
  el.shelfCount.textContent = state.books.length ? `共 ${state.books.length} 本` : '';

  if (!state.books.length) {
    grid.innerHTML = `<div class="shelf-empty">
      <h2>书架还是空的</h2>
      <p>点右上角 ⚙ 添加一本书：粘一个 GitHub 仓库地址（Pile 会克隆到自己的目录，只拉取不推送），
        或者填一个本地目录（只读浏览，不联网）。</p>
      <p class="muted">也可以在数据目录的 <code>books.json</code> 里手写条目。</p>
    </div>`;
    return;
  }

  grid.innerHTML = state.books.map((b) => {
    // 封面用书名里第一个汉字/字母，别拿"2026"的 2 当封面
    const tm = (b.title || '?').trim().match(/[\u4e00-\u9fa5A-Za-z]/);
    const initial = esc(tm ? tm[0] : (b.title || '?').trim().slice(0, 1));
    const src = b.kind === 'local' ? '本地目录'
      : b.kind === 'git-external' ? '外部仓库' : '';
    const meta = b.ready
      ? `${src ? src + ' · ' : ''}${b.count} 篇`
      : (b.kind === 'local' ? '目录不存在' : '未克隆到本地');
    return `<article class="book-card${b.ready ? '' : ' not-ready'}" data-id="${esc(b.id)}"
        tabindex="0" role="link" aria-label="${esc(b.title)}"
        style="--cover:${esc(b.cover || '#4c6ef5')}">
      <div class="book-cover"><span class="book-initial">${initial}</span></div>
      <div class="book-body">
        <h3 class="book-title">${esc(b.title)}</h3>
        <p class="book-sub">${esc(b.subtitle || '')}</p>
        <p class="book-meta">${b.ready ? '<span class="dot ok"></span>' : '<span class="dot warn"></span>'}${esc(meta)}</p>
      </div>
    </article>`;
  }).join('');

  grid.querySelectorAll('.book-card').forEach((card) => {
    const open = () => go(readUrl(card.dataset.id, ''));
    card.onclick = open;
    card.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } };
  });
}

/* ------------------------------------------------ 打开一本书 */
async function openBook(bookId, path, mode = 'replace') {
  if (!state.books.length) await loadLibrary();
  const book = state.books.find((b) => b.id === bookId) || null;
  const switched = state.bookId !== bookId;

  state.bookId = bookId;
  state.book = book;
  if (switched) {
    state.current = null;
    state.tree = [];
    el.tree.innerHTML = '<div class="empty-hint">加载中…</div>';
    el.article.innerHTML = '<div class="welcome"><h1>加载中…</h1></div>';
  }

  el.shelfView.hidden = true;
  el.readerView.hidden = false;
  document.body.className = 'view-reader';
  el.readerTitle.textContent = book ? book.title : bookId;
  el.readerTitle.title = book && book.remote ? book.remote : '';

  const st = await refreshState();

  if (st && st.ok) await maybeSoftRefresh();

  if (!st || !st.ok) {
    el.tree.innerHTML = '<div class="empty-hint">这本书打不开</div>';
    el.article.innerHTML = `<div class="welcome">
      <h1>${book ? esc(book.title) : '这本书'}还没准备好</h1>
      <p>${esc((st && st.error) || '仓库里找不到这本书的目录，或它还没克隆到本地。')}</p>
      <p class="muted">在 <code>books.json</code> 里检查这本书的 <code>repo</code> 与 <code>dir</code>，
        或者点左下角「连接其他仓库」先把它克隆下来。</p>
    </div>`;
    return;
  }

  const want = path || localStorage.getItem(`np:last:${bookId}`) || firstFile(state.tree);
  if (want && !switched && state.current === want) return; // 已经在读这一篇
  if (want) return openDoc(want, { mode });
  el.article.innerHTML = '<div class="welcome"><h1>这本书里没有 Markdown 文件</h1></div>';
}

/* ------------------------------------------------ 文件树 */
function renderTree(nodes, container) {
  container.innerHTML = '';
  if (!nodes.length) {
    container.innerHTML = '<div class="empty-hint">这本书里没有 Markdown 文件</div>';
    return;
  }
  const frag = document.createDocumentFragment();
  for (const n of nodes) frag.appendChild(buildNode(n));
  container.appendChild(frag);
}

function fileRow(name, path) {
  const a = document.createElement('a');
  a.className = 'file';
  a.textContent = name;
  a.title = path;
  a.dataset.path = path;
  a.onclick = (e) => { e.preventDefault(); openDoc(path); };
  return a;
}

const indexOf = (dir) =>
  dir.children.find((c) => c.type === 'file' && c.name.toLowerCase() === 'index.md');

function buildNode(node) {
  if (node.type === 'file') return fileRow(node.name.replace(/\.md$/i, ''), node.path);

  // 中间层目录没有 index.md 时合并成一行：courses / 2026-nju-genai-se
  let label = node.name;
  let cur = node;
  let idx = indexOf(cur);
  while (!idx && cur.children.length === 1 && cur.children[0].type === 'dir') {
    cur = cur.children[0];
    label += ' / ' + cur.name;
    idx = indexOf(cur);
  }
  const rest = cur.children.filter((c) => c !== idx);

  // 目录里只有一个 index.md：直接当一篇笔记显示
  if (idx && rest.length === 0) return fileRow(label, idx.path);

  const wrap = document.createElement('div');
  wrap.className = 'dir';
  const head = document.createElement('div');
  head.className = 'dir-label' + (idx ? ' openable' : '');
  head.innerHTML = `<span class="caret">▾</span><span class="dir-name">${esc(label)}</span>`;
  head.firstChild.onclick = (e) => { e.stopPropagation(); wrap.classList.toggle('closed'); };
  if (idx) {
    head.dataset.path = idx.path;
    head.lastChild.onclick = (e) => { e.stopPropagation(); openDoc(idx.path); };
    head.lastChild.title = '打开本节目录页';
  } else {
    head.onclick = () => wrap.classList.toggle('closed');
  }
  const kids = document.createElement('div');
  kids.className = 'children';
  for (const c of rest) kids.appendChild(buildNode(c));
  wrap.append(head, kids);
  return wrap;
}

function markActive(path) {
  document.querySelectorAll('.tree [data-path]').forEach((n) =>
    n.classList.toggle('active', n.dataset.path === path));
}

function filterTree(q) {
  const query = q.trim().toLowerCase();
  document.querySelectorAll('.tree .file').forEach((a) => {
    const hit = !query || a.dataset.path.toLowerCase().includes(query) || a.textContent.toLowerCase().includes(query);
    a.style.display = hit ? '' : 'none';
  });
  document.querySelectorAll('.tree .dir').forEach((d) => {
    const visible = [...d.querySelectorAll('.file')].some((a) => a.style.display !== 'none');
    d.style.display = visible ? '' : 'none';
  });
}

/* ------------------------------------------------ 渲染文档 */
marked.setOptions({ gfm: true, breaks: false });

function renderMarkdown(md) {
  const html = marked.parse(md);
  return DOMPurify.sanitize(html, { ADD_ATTR: ['target', 'id'] });
}

/* 笔记里的相对图片：/read/<书>/<文档> 这种地址下相对路径拿不到文件，
   统一改写成 /api/asset?book=..&path=..，由服务端按书根解析。 */
function joinRel(fromDoc, src) {
  const dir = fromDoc.includes('/') ? fromDoc.slice(0, fromDoc.lastIndexOf('/')) : '';
  const raw = decodeURI(src);
  const parts = (dir ? dir.split('/') : []).concat(raw.split('/'));
  const out = [];
  for (const p of parts) {
    if (!p || p === '.') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return out.join('/');
}

function rewriteImages(docPath) {
  el.article.querySelectorAll('img[src]').forEach((img) => {
    const src = img.getAttribute('src') || '';
    if (!src || /^(https?:|data:|blob:|\/)/i.test(src)) return;
    const rel = joinRel(docPath, src);
    if (!rel) return;
    img.setAttribute('src', withBook(`/api/asset?path=${encodeURIComponent(rel)}`));
    img.setAttribute('loading', 'lazy');
  });
}

function decorateArticle() {
  // 标题加锚点
  const heads = [...el.article.querySelectorAll('h1, h2, h3, h4')];
  heads.forEach((h, i) => {
    if (!h.id) h.id = `h-${i}`;
  });
  // 外链新窗口
  el.article.querySelectorAll('a[href^="http"]').forEach((a) => {
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  });
  // 代码高亮
  el.article.querySelectorAll('pre code').forEach((b) => {
    try { hljs.highlightElement(b); } catch (_) {}
  });
  buildToc();
}

function buildToc() {
  const heads = [...el.article.querySelectorAll('h2, h3')];
  el.toc.innerHTML = '';
  document.body.classList.toggle('no-toc', heads.length === 0);
  if (!heads.length) return;
  const frag = document.createDocumentFragment();
  heads.forEach((h) => {
    const a = document.createElement('a');
    a.href = `#${h.id}`;
    a.textContent = h.textContent.replace(/^#+\s*/, '');
    a.className = h.tagName === 'H3' ? 'lv3' : '';
    a.onclick = (e) => {
      e.preventDefault();
      el.content.scrollTo({ top: h.offsetTop - 60, behavior: 'smooth' });
    };
    frag.appendChild(a);
  });
  el.toc.appendChild(frag);
  observeHeads(heads);
}

let observer = null;
function observeHeads(heads) {
  if (observer) observer.disconnect();
  observer = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (e.isIntersecting) {
        document.querySelectorAll('.toc a').forEach((a) =>
          a.classList.toggle('active', a.getAttribute('href') === `#${e.target.id}`));
      }
    });
  }, { root: el.content, rootMargin: '-10% 0px -75% 0px' });
  heads.forEach((h) => observer.observe(h));
}

async function openDoc(path, opts = {}) {
  const res = await api(withBook(`/api/doc?path=${encodeURIComponent(path)}`));
  if (!res.ok) {
    el.article.innerHTML = `<p class="muted">打开失败：${esc(res.error || '未知错误')}</p>`;
    return;
  }
  // 记住上一条的阅读位置
  if (state.current) {
    localStorage.setItem(`np:pos:${state.bookId}:${state.current}`, String(el.content.scrollTop));
  }
  state.current = path;
  markActive(path);
  localStorage.setItem(`np:last:${state.bookId}`, path);
  const name = path.split('/').pop().replace(/\.md$/i, '');
  const fmTitle = (res.meta && res.meta.title) || '';
  const label = fmTitle || name;
  document.title = state.book ? `${label} · ${state.book.title}` : label;

  el.article.innerHTML = renderMarkdown(res.markdown);
  // 文档没有一级标题时，用 front-matter 的 title 当标题
  if (!el.article.querySelector('h1') && fmTitle) {
    const h = document.createElement('h1');
    h.textContent = fmTitle;
    el.article.insertBefore(h, el.article.firstChild);
  }
  rewriteImages(path);
  decorateArticle();
  const saved = Number(localStorage.getItem(`np:pos:${state.bookId}:${path}`) || 0);
  el.content.scrollTop = opts.jumpSearch ? 0 : saved;

  if (opts.query) highlightQuery(opts.query);

  // 只更新地址栏，不再走 route()，否则 route → openBook → openDoc 会互相递归
  const url = readUrl(state.bookId, path);
  if (location.pathname + location.search !== url) {
    if (opts.mode === 'replace') history.replaceState(null, '', url);
    else history.pushState(null, '', url);
  }
}

/* 在正文里高亮并滚动到第一个匹配 */
function highlightQuery(q) {
  if (!q || q.length < 2) return;
  const lower = q.toLowerCase();
  const walker = document.createTreeWalker(el.article, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let n;
  while ((n = walker.nextNode())) {
    if (n.nodeValue.toLowerCase().includes(lower)) nodes.push(n);
  }
  let first = null;
  for (const node of nodes) {
    const idx = node.nodeValue.toLowerCase().indexOf(lower);
    if (idx < 0) continue;
    const range = document.createRange();
    range.setStart(node, idx);
    range.setEnd(node, idx + q.length);
    const mark = document.createElement('mark');
    range.surroundContents(mark);
    if (!first) first = mark;
    if (nodes.length > 40) break;
  }
  if (first) first.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

/* ------------------------------------------------ 状态与更新 */
const REFRESH_TTL = 5 * 60 * 1000;   // 同一本书 5 分钟内只自动拉一次

function renderStatus(st) {
  const btn = $('#btn-sync');
  if (!st || !st.ok) {
    el.chip.textContent = '未连接';
    el.chip.title = '';
    el.status.textContent = st && st.error ? st.error : '—';
    el.status.className = 'sync-status';
    if (btn) btn.hidden = true;
    return;
  }
  el.chip.textContent = st.path ? st.path.split(/[\\/]/).pop() : '—';
  el.chip.title = st.path || '';
  el.chip.dataset.ok = '1';

  // 本地目录书：纯静态只读，没有「更新」这回事
  if (st.kind === 'local') {
    el.status.textContent = '本地目录 · 只读';
    el.status.className = 'sync-status local';
    if (btn) btn.hidden = true;
    return;
  }

  // 用户自己的仓库目录：Pile 不碰，不联网
  if (st.kind === 'git-external') {
    el.status.textContent = '外部仓库 · 不自动更新';
    el.status.className = 'sync-status external';
    if (btn) btn.hidden = true;
    return;
  }

  if (btn) btn.hidden = false;
  const bits = [];
  if (st.dirty_count) bits.push(`本地 ${st.dirty_count} 处改动`);
  if (st.behind) bits.push(`远端 ${st.behind} 个新提交`);
  if (!bits.length) bits.push('已是最新');
  el.status.textContent = bits.join(' · ');
  el.status.className = 'sync-status'
    + (st.dirty_count ? ' dirty' : '') + (st.behind ? ' behind' : '');
  el.status.title = st.push_disabled === false
    ? '注意：这个仓库还能推送，点「刷新」时会被重新禁用'
    : 'Pile 只拉取，不推送';
}

async function refreshState() {
  const st = await api(withBook('/api/state'));
  state.configured = !!st.configured && !!st.ok;
  state.repoPath = st.path || '';
  renderStatus(st);
  if (state.configured) {
    const t = await api(withBook('/api/tree'));
    state.tree = t.tree || [];
    renderTree(state.tree, el.tree);
    el.tree.scrollTop = 0;
  }
  return st;
}

function findPath(nodes, path) {
  for (const n of nodes) {
    if (n.type === 'file' && n.path === path) return true;
    if (n.type === 'dir' && findPath(n.children, path)) return true;
  }
  return false;
}

function firstFile(nodes) {
  // 优先首页：根目录 README.md，其次顶层目录里的 index.md，最后任意文件
  for (const n of nodes) {
    if (n.type === 'file' && /^readme\.md$/i.test(n.name)) return n.path;
  }
  // 其次根目录的 index.md：一本书的目录页
  for (const n of nodes) {
    if (n.type === 'file' && /^index\.md$/i.test(n.name)) return n.path;
  }
  for (const n of nodes) {
    if (n.type === 'dir') {
      const idx = indexOf(n);
      if (idx) return idx.path;
    }
  }
  return anyFile(nodes);
}

function anyFile(nodes) {
  for (const n of nodes) {
    if (n.type === 'file') return n.path;
    if (n.type === 'dir') { const f = anyFile(n.children); if (f) return f; }
  }
  return null;
}

/** 打开一本书时，后台拉一次（同一本书 5 分钟内不重复）。 */
async function maybeSoftRefresh() {
  const b = state.book;
  if (!b || b.kind !== 'git-managed' || !b.ready) return;
  const key = `pile:fresh:${b.id}`;
  const last = Number(localStorage.getItem(key) || 0);
  if (Date.now() - last < REFRESH_TTL) return;
  localStorage.setItem(key, String(Date.now()));
  try {
    const rep = await post(withBook('/api/refresh'));
    if (rep.code === 'dirty') { showDiscard(rep.dirty || []); return; }
    if (rep.ok && rep.pulled) await refreshState();
  } catch { /* 离线时静默，不打扰阅读 */ }
}

async function doRefresh(discard = false) {
  const btn = $('#btn-sync');
  if (btn) { btn.disabled = true; btn.textContent = discard ? '更新中…' : '检查中…'; }
  try {
    const rep = await post(withBook('/api/refresh'), { discard });
    if (rep.code === 'dirty') { showDiscard(rep.dirty || []); return; }
    if (rep.code === 'local' || rep.code === 'external') {
      showReport({ ok: false, error: rep.error, steps: [] });
      return;
    }
    showReport(rep);
    await refreshState();
    if (rep.ok && rep.pulled && state.current) openDoc(state.current, { mode: 'replace' });
  } catch (e) {
    showReport({ ok: false, error: String(e), steps: [] });
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '刷新'; }
  }
}

function showDiscard(files) {
  el.discardList.innerHTML = files.length
    ? `<div class="discard-files">${files.map((f) => `<code>${esc(f)}</code>`).join(' ')}</div>`
    : '';
  el.discardOverlay.hidden = false;
}

function showReport(rep) {
  $('#report-title').textContent = rep.ok
    ? ((rep.pulled || 0) > 0 ? '更新完成' : '已经是最新的')
    : '更新未完成';
  const rows = (rep.steps || []).map((s) => `
    <div class="report-step">
      <span class="mark ${s.ok ? 'ok' : 'bad'}">${s.ok ? '✓' : '✗'}</span>
      <span>${esc(s.name)}${s.detail ? `<div class="detail">${esc(s.detail)}</div>` : ''}</span>
    </div>`).join('');
  const summary = rep.ok
    ? `<p class="muted">${(rep.pulled || 0) > 0
        ? `从远端拉取 ${rep.pulled} 个提交。`
        : '远端没有新提交。'}Pile 不会上传任何内容。</p>`
    : `<p class="muted">${esc(rep.error || '')}</p>`;
  const discarded = (rep.discarded || []).length
    ? `<div class="report-conflict">已丢弃的本地改动${rep.trash ? `（备份：<code>${esc(rep.trash)}</code>）` : ''}：<br>${
        rep.discarded.map((c) => `<code>${esc(c)}</code>`).join(' ')}</div>`
    : '';
  $('#report-body').innerHTML = summary + rows + discarded;
  el.reportOverlay.hidden = false;
}

/* ------------------------------------------------ 搜索 */
let searchTimer = null;
function openSearch() {
  if (!state.configured) return;
  el.searchOverlay.hidden = false;
  el.searchInput.value = state.query || '';
  el.searchInput.focus();
  el.searchInput.select();
  if (el.searchInput.value) runSearch(el.searchInput.value);
}

async function runSearch(q) {
  state.query = q;
  if (q.trim().length < 2) {
    el.searchResults.innerHTML = '';
    el.searchMeta.textContent = '至少输入 2 个字符';
    return;
  }
  el.searchMeta.textContent = '搜索中…';
  const res = await api(withBook(`/api/search?q=${encodeURIComponent(q)}`));
  const hits = res.hits || [];
  el.searchMeta.textContent = hits.length ? `找到 ${hits.length} 处` : '没有匹配';
  const lower = q.toLowerCase();
  el.searchResults.innerHTML = hits.map((h, i) => {
    const raw = h.text;
    const idx = raw.toLowerCase().indexOf(lower);
    let text = esc(raw);
    if (idx >= 0) {
      text = esc(raw.slice(0, idx)) + '<em>' + esc(raw.slice(idx, idx + q.length)) + '</em>'
        + esc(raw.slice(idx + q.length));
    }
    return `<div class="search-hit" data-i="${i}" data-path="${esc(h.path)}">
      <div class="hit-path">${esc(h.path)} : ${h.line}</div>
      <div class="hit-text">${text}</div></div>`;
  }).join('');

  el.searchResults.querySelectorAll('.search-hit').forEach((d) => {
    d.onclick = async () => {
      el.searchOverlay.hidden = true;
      await openDoc(d.dataset.path, { query: q, jumpSearch: true });
    };
  });
}

/* ------------------------------------------------ 设置浮层 */
function openSetup() {
  el.setupOverlay.hidden = false;
  $('#input-path').value = state.repoPath || '';
  $('#setup-msg').textContent = '';
  $('#input-path').focus();
  $('#setup-msg').textContent = '';
}

async function submitSetup() {
  const clean = (v) => String(v || '').trim().replace(/^["']|["']$/g, '');
  const url = clean($('#input-path').value);
  const local = clean($('#input-local').value);
  const token = clean($('#input-token').value);
  const msg = (t) => { $('#setup-msg').textContent = t; };
  if (url && local) { msg('两栏只填一个：仓库地址，或者本地目录'); return; }
  if (!url && !local) { msg('请填写仓库地址或本地目录'); return; }

  const isUrl = /^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/i.test(url || local);
  if (url && !isUrl) { msg('仓库地址要以 https:// 或 git@ 开头'); return; }

  if (url) {
    msg('正在克隆到 Pile 自己的目录，仓库大时要等一会儿…');
    const r = await post('/api/clone', { url, token });
    if (!r.ok) { msg(r.error || '克隆失败'); return; }
  } else {
    msg('正在添加本地目录…');
    const r = await post('/api/add-local', { path: local });
    if (!r.ok) { msg(r.error || '添加失败'); return; }
  }

  msg('');
  el.setupOverlay.hidden = true;
  $('#input-token').value = '';
  $('#input-path').value = '';
  $('#input-local').value = '';
  state.books = [];
  await route();
}

/* ------------------------------------------------ 事件绑定 */
function bindEvents() {
  $('#btn-back').onclick = () => go('/');
  $('#btn-sync').onclick = () => doRefresh(false);
  $('#btn-search').onclick = openSearch;
  $('#btn-theme').onclick = toggleTheme;
  $('#btn-theme-shelf').onclick = toggleTheme;
  $('#btn-settings').onclick = openSetup;
  $('#btn-settings-shelf').onclick = openSetup;
  $('#btn-menu').onclick = () => {
    if (innerWidth <= 780) document.body.classList.toggle('mobile-open');
    else document.body.classList.toggle('collapsed');
  };
  $('#tree-filter').oninput = (e) => filterTree(e.target.value);

  $('#btn-cancel-setup').onclick = () => { el.setupOverlay.hidden = true; };
  $('#btn-do-setup').onclick = submitSetup;
  $('#btn-close-report').onclick = () => { el.reportOverlay.hidden = true; };
  $('#btn-discard-cancel').onclick = () => { el.discardOverlay.hidden = true; };
  $('#btn-discard-confirm').onclick = () => {
    el.discardOverlay.hidden = true;
    doRefresh(true);
  };

  el.searchInput.oninput = (e) => {
    clearTimeout(searchTimer);
    const v = e.target.value;
    searchTimer = setTimeout(() => runSearch(v), 180);
  };

  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA)$/.test(e.target.tagName);
    const overlayOpen = !el.searchOverlay.hidden || !el.setupOverlay.hidden
      || !el.reportOverlay.hidden || !el.discardOverlay.hidden;
    if (e.key === '/' && !typing && !overlayOpen) {
      e.preventDefault(); openSearch();
    } else if (e.key === 'Escape') {
      if (overlayOpen) {
        el.searchOverlay.hidden = true;
        el.setupOverlay.hidden = true;
        el.reportOverlay.hidden = true;
        el.discardOverlay.hidden = true;
        document.body.classList.remove('mobile-open');
      } else if (state.bookId) {
        go('/');
      }
    } else if (e.key === 'j' && !typing && state.bookId) {
      el.content.scrollBy({ top: 180 });
    } else if (e.key === 'k' && !typing && state.bookId) {
      el.content.scrollBy({ top: -180 });
    } else if (e.key === 's' && (e.ctrlKey || e.metaKey) && state.bookId) {
      e.preventDefault(); doRefresh(false);
    }
  });

  // 点击遮罩关闭
  [el.searchOverlay, el.setupOverlay, el.reportOverlay, el.discardOverlay].forEach((o) => {
    o.addEventListener('click', (e) => { if (e.target === o) o.hidden = true; });
  });

  window.addEventListener('popstate', () => route());
}

/* ------------------------------------------------ 启动 */
async function boot() {
  applyTheme(localStorage.getItem('np:theme') || 'auto');
  bindEvents();

  // 兼容旧链接：?path=xxx 或 ?book=xxx
  const params = new URLSearchParams(location.search);
  const legacyPath = params.get('path');
  if (legacyPath && !parseRoute()) {
    const bid = params.get('book') || '';
    await loadLibrary();
    const book = state.books.find((b) => b.id === bid) || state.books[0];
    if (book) {
      history.replaceState(null, '', readUrl(book.id, legacyPath));
      return route();
    }
  }

  await route();

  const q = params.get('q');
  if (q && state.bookId) {
    el.searchOverlay.hidden = false;
    el.searchInput.value = q;
    runSearch(q);
  }
  if (params.has('setup') || (!state.books.length && !parseRoute())) openSetup();
}

boot();
