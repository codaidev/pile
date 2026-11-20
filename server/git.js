'use strict';
/**
 * git 层：只读模型。
 *
 * Pile 对仓库只做三件事：克隆、拉取并快进、报告状态。
 * 它不提交、不推送、不改写历史 —— 代码里没有任何 add/commit/push 调用。
 *
 * 结构性保证：克隆完成后把 remote.origin.pushurl 指向一个无效地址，
 * 即使有人拿到这个仓库手动 push 也会失败；每次拉取前再复核一次，
 * 防止有谁手动改回去。
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const store = require('./store');

const NO_PUSH_URL = 'https://push.disabled/pile';

let gitBinOverride = '';

function setGitBin(p) { gitBinOverride = p || ''; }

function findGit() {
  if (gitBinOverride && fs.existsSync(gitBinOverride)) return gitBinOverride;
  const candidates = [];
  // 打包后：resources/git/cmd/git.exe；开发时：desktop/git/cmd/git.exe
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'git', 'cmd', 'git.exe'));
  candidates.push(
    path.resolve(__dirname, '..', 'git', 'cmd', 'git.exe'),
    'C:\\Program Files\\Git\\cmd\\git.exe',
    'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'cmd', 'git.exe')
  );
  for (const p of candidates) {
    try { if (p && fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return 'git';
}

function baseArgs() {
  return [
    '-c', 'http.sslBackend=openssl',
    '-c', 'credential.helper=',
    '-c', 'core.quotepath=false',
    '-c', 'core.precomposeunicode=true',
  ];
}

function authArgs(token) {
  if (!token) return [];
  const basic = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
  return ['-c', `http.https://github.com/.extraheader=Authorization: Basic ${basic}`];
}

/**
 * @returns {Promise<{code:number, out:string, err:string}>}
 */
function runGit(args, cwd, { token = '', timeout = 120000 } = {}) {
  const git = findGit();
  const argv = [...baseArgs(), ...authArgs(token), ...args];
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: 'echo',
    LC_ALL: 'C.UTF-8',
    PATH: `${path.dirname(git)}${path.delimiter}${process.env.PATH || ''}`,
  };
  // PortableGit 的 exec-path 在 ucrt64/libexec/git-core；存在时才显式指定
  const execPath = path.resolve(path.dirname(git), '..', 'ucrt64', 'libexec', 'git-core');
  if (fs.existsSync(execPath)) env.GIT_EXEC_PATH = execPath;
  return new Promise((resolve) => {
    execFile(git, argv, {
      cwd,
      env,
      timeout,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'utf8',
      // 不继承任何交互式输入，避免误挂起
      stdio: ['ignore', 'pipe', 'pipe'],
    }, (error, stdout, stderr) => {
      const out = (stdout || '').trim();
      const err = (stderr || '').trim();
      if (!error) return resolve({ code: 0, out, err });
      if (error.code === 'ENOENT') return resolve({ code: 127, out, err: `找不到 git：${git}` });
      if (error.killed) return resolve({ code: 124, out, err: `git 超时（>${Math.round(timeout / 1000)}s）` });
      resolve({ code: typeof error.code === 'number' ? error.code : 1, out, err });
    });
  });
}

async function revParseBranch(dir) {
  const r = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], dir);
  return r.code === 0 ? r.out : 'HEAD';
}

async function countAheadBehind(dir, branch) {
  const r = await runGit(['rev-list', '--left-right', '--count', `HEAD...origin/${branch}`], dir);
  const parts = (r.out || '').split(/\s+/).filter(Boolean);
  if (r.code === 0 && parts.length === 2) {
    return { ahead: parseInt(parts[0], 10) || 0, behind: parseInt(parts[1], 10) || 0 };
  }
  return { ahead: 0, behind: 0 };
}

/**
 * 让这个仓库推不出去：pushurl 指向一个必然连接失败、且不是 GitHub 的地址。
 * 只改本地配置，不动远端、不动工作区。
 */
async function ensureNoPush(repoPath) {
  const cur = await runGit(['remote', 'get-url', '--push', 'origin'], repoPath);
  if (cur.code === 0 && cur.out.trim() === NO_PUSH_URL) return { ok: true, changed: false };
  const set = await runGit(['config', 'remote.origin.pushurl', NO_PUSH_URL], repoPath);
  return { ok: set.code === 0, changed: true, error: set.err };
}

/**
 * 只读状态：默认不联网（fetch=false），打开书时不会因为网络卡住界面。
 */
async function repoState(repoPath, { fetch: doFetch = false, token = store.getToken() } = {}) {
  if (!repoPath || !fs.existsSync(path.join(repoPath, '.git'))) {
    return { ok: false, error: '该目录不是 git 仓库' };
  }
  const branch = await revParseBranch(repoPath);
  const remoteRes = await runGit(['remote', 'get-url', 'origin'], repoPath);
  if (remoteRes.code !== 0) {
    return { ok: false, error: '仓库没有配置 origin 远端' };
  }
  if (doFetch) {
    await runGit(['fetch', '--quiet', 'origin'], repoPath, { token, timeout: 90000 });
  }
  const { ahead, behind } = await countAheadBehind(repoPath, branch);
  const pushUrl = await runGit(['remote', 'get-url', '--push', 'origin'], repoPath);
  const statusRes = await runGit(['status', '--porcelain'], repoPath);
  const dirty = statusRes.code === 0
    ? statusRes.out.split(/\r?\n/).filter((l) => l.trim()).map((l) => l.slice(3))
    : [];
  const logRes = await runGit(['log', '-1', '--format=%h %s', 'HEAD'], repoPath);

  return {
    ok: true,
    path: repoPath,
    branch,
    remote: remoteRes.out,
    push_disabled: pushUrl.code === 0 && pushUrl.out.trim() === NO_PUSH_URL,
    ahead,
    behind,
    dirty,
    dirty_count: dirty.length,
    head: logRes.code === 0 ? logRes.out : '',
    last_sync: store.loadConfig().last_sync || 0,
    git: findGit(),
  };
}

/**
 * 克隆到 Pile 自己的目录，克隆完立刻堵死 push。
 */
async function cloneRepo(url, dest, token) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const r = await runGit(['clone', '--progress', url, dest], path.dirname(dest), { token, timeout: 600000 });
  if (r.code !== 0) return { ok: false, error: r.err || r.out || '克隆失败' };
  await ensureNoPush(dest);
  return { ok: true, path: dest };
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 丢弃本地改动之前，先把已跟踪文件的改动存成 patch，人工还能找回来。 */
async function savePatch(repoPath, bookId) {
  const diff = await runGit(['diff', 'HEAD'], repoPath);
  if (diff.code !== 0 || !diff.out.trim()) return '';
  try {
    const dir = path.join(store.getDataDir(), 'trash');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${bookId}-${stamp()}.patch`);
    fs.writeFileSync(file, diff.out, 'utf8');
    return file;
  } catch {
    return '';
  }
}

/**
 * 单向更新：fetch → 快进到远端。绝不提交、绝不推送。
 *
 * - 本地干净：直接快进。
 * - 本地有改动：默认拒绝（code='dirty'），把文件列表交给前端去问用户。
 * - discard=true：先把改动存成 patch，再 reset --hard 对齐远端。
 */
async function pullRepo(repoPath, { discard = false, bookId = '' } = {}) {
  const token = store.getToken();
  const report = { ok: false, steps: [], pulled: 0, discarded: [], trash: '' };
  const step = (name, ok, detail = '') => {
    report.steps.push({ name, ok, detail });
    return ok;
  };

  const branchRes = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath);
  if (branchRes.code !== 0) {
    report.error = '无法读取当前分支';
    return report;
  }
  const branch = branchRes.out.trim();

  // 0. 复核 push 通道确实被堵死（本地配置，不联网）
  const guard = await ensureNoPush(repoPath);
  step('确认不可推送', guard.ok, guard.ok ? 'push 通道已禁用' : (guard.error || '无法写入 pushurl'));

  // 1. 本地改动检查
  const st = await runGit(['status', '--porcelain'], repoPath);
  const dirty = st.code === 0
    ? st.out.split(/\r?\n/).filter((l) => l.trim()).map((l) => l.slice(3))
    : [];
  if (dirty.length && !discard) {
    step('检查本地改动', false, `${dirty.length} 个文件有改动`);
    report.code = 'dirty';
    report.dirty = dirty;
    report.error = '本地有改动，Pile 不会替你提交或丢弃';
    return report;
  }
  step('检查本地改动', true, dirty.length ? `${dirty.length} 个文件（将丢弃）` : '工作区干净');

  // 2. 拉取
  const fetchRes = await runGit(['fetch', 'origin'], repoPath, { token, timeout: 180000 });
  if (!step('拉取远端', fetchRes.code === 0, fetchRes.code ? fetchRes.err : '')) {
    report.error = fetchRes.err || 'fetch 失败';
    return report;
  }

  const { behind } = await countAheadBehind(repoPath, branch);
  report.behind = behind;

  // 3. 丢弃本地改动（用户已确认）
  if (dirty.length && discard) {
    report.trash = await savePatch(repoPath, bookId || path.basename(repoPath));
    const r = await runGit(['reset', '--hard', `origin/${branch}`], repoPath);
    step('丢弃本地改动', r.code === 0, report.trash ? `改动已备份到 ${report.trash}` : '未备份');
    report.discarded = dirty;
    if (r.code !== 0) {
      report.error = r.err || 'reset 失败';
      return report;
    }
    report.pulled = behind;
  } else if (behind) {
    // 4. 快进
    const mg = await runGit(['merge', '--ff-only', `origin/${branch}`], repoPath);
    if (!step('快进到远端', mg.code === 0, mg.code ? (mg.err || '').slice(0, 300) : `${behind} 个提交`)) {
      report.error = (mg.err || '快进失败').slice(0, 300);
      return report;
    }
    report.pulled = behind;
  } else {
    step('快进到远端', true, '远端没有新提交');
  }

  const headRes = await runGit(['log', '-1', '--format=%h %s', 'HEAD'], repoPath);
  report.head = headRes.code === 0 ? headRes.out : '';

  const cfg = store.loadConfig();
  cfg.last_sync = Math.floor(Date.now() / 1000);
  store.saveConfig(cfg);
  report.ok = true;
  return report;
}

module.exports = {
  setGitBin, findGit, runGit, repoState, cloneRepo, pullRepo, ensureNoPush, NO_PUSH_URL,
};
