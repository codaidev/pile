'use strict';
/**
 * git 层：调用 bundled PortableGit。
 * 与 Python 版行为完全一致：提交 → fetch → rebase/ff-only → push，冲突即 abort，绝不 force。
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const store = require('./store');

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

// 提交 / 变基 / 合并需要身份信息；用户机器上常常没配全局 user.name、user.email，
// 缺失时 rebase 会报 "Committer identity unknown"，以前被误判成冲突。
const IDENTITY_ARGS = ['-c', 'user.name=Pile', '-c', 'user.email=pile@localhost'];
const MUTATING = new Set(['commit', 'rebase', 'merge', 'cherry-pick', 'revert', 'am', 'stash', 'tag']);

/**
 * 找出真正的子命令（跳过 -c key=value 这类选项）
 */
function subcommand(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-c') { i++; continue; }
    if (a.startsWith('-')) continue;
    return a;
  }
  return '';
}

/**
 * @returns {Promise<{code:number, out:string, err:string}>}
 */
function runGit(args, cwd, { token = '', timeout = 180000 } = {}) {
  const git = findGit();
  const idArgs = MUTATING.has(subcommand(args)) ? IDENTITY_ARGS : [];
  const argv = [...baseArgs(), ...authArgs(token), ...idArgs, ...args];
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

async function repoState(repoPath) {
  if (!repoPath || !fs.existsSync(path.join(repoPath, '.git'))) {
    return { ok: false, error: '该目录不是 git 仓库' };
  }
  const branch = await revParseBranch(repoPath);
  const remoteRes = await runGit(['remote', 'get-url', 'origin'], repoPath);
  if (remoteRes.code !== 0) {
    return { ok: false, error: '仓库没有配置 origin 远端' };
  }
  const remote = remoteRes.out;

  await runGit(['fetch', '--quiet', 'origin'], repoPath, { token: store.getToken(), timeout: 90000 });
  const { ahead, behind } = await countAheadBehind(repoPath, branch);

  const statusRes = await runGit(['status', '--porcelain'], repoPath);
  const dirty = statusRes.code === 0
    ? statusRes.out.split(/\r?\n/).filter((l) => l.trim()).map((l) => l.slice(3))
    : [];

  const logRes = await runGit(['log', '-1', '--format=%h %s', 'HEAD'], repoPath);

  return {
    ok: true,
    path: repoPath,
    branch,
    remote,
    ahead,
    behind,
    dirty,
    dirty_count: dirty.length,
    head: logRes.code === 0 ? logRes.out : '',
    last_sync: store.loadConfig().last_sync || 0,
    git: findGit(),
  };
}

async function cloneRepo(url, dest, token) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const r = await runGit(['clone', '--progress', url, dest], path.dirname(dest), { token, timeout: 600000 });
  if (r.code !== 0) return { ok: false, error: r.err || r.out || '克隆失败' };
  return { ok: true, path: dest };
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function syncRepo(repoPath) {
  const token = store.getToken();
  const report = { steps: [], ok: false, conflicts: [], pushed: 0, pulled: 0 };
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

  // 1. 本地改动先提交，保证任何情况下不丢
  const st = await runGit(['status', '--porcelain'], repoPath);
  if (st.out.trim()) {
    await runGit(['add', '-A'], repoPath);
    const msg = `notes: auto commit ${stamp()}`;
    const c = await runGit(
      ['-c', 'user.name=Pile', '-c', 'user.email=pile@localhost', 'commit', '-m', msg],
      repoPath
    );
    step('提交本地改动', c.code === 0, `${st.out.split(/\r?\n/).filter((x) => x.trim()).length} 个文件`);
  } else {
    step('提交本地改动', true, '没有改动');
  }

  // 2. 拉取
  const fetchRes = await runGit(['fetch', 'origin'], repoPath, { token, timeout: 180000 });
  if (!step('拉取远端', fetchRes.code === 0, fetchRes.code ? fetchRes.err : '')) {
    report.error = fetchRes.err || 'fetch 失败';
    return report;
  }

  const { ahead, behind } = await countAheadBehind(repoPath, branch);
  report.ahead = ahead;
  report.behind = behind;

  // 3. 合并远端
  if (behind) {
    if (ahead) {
      const rb = await runGit(['rebase', `origin/${branch}`], repoPath, { timeout: 180000 });
      if (rb.code !== 0) {
        const cf = await runGit(['diff', '--name-only', '--diff-filter=U'], repoPath);
        const conflicts = cf.out.split(/\r?\n/).filter((x) => x.trim());
        await runGit(['rebase', '--abort'], repoPath);
        if (conflicts.length) {
          step('变基到远端', false, '存在冲突，已回滚到同步前状态');
          report.conflicts = conflicts;
          report.error = '存在冲突，需要手工解决';
        } else {
          step('变基到远端', false, (rb.err || 'rebase 失败').slice(0, 400));
          report.error = (rb.err || 'rebase 失败').slice(0, 400);
        }
        return report;
      }
      step('变基到远端', true, `${behind} 个提交`);
      report.pulled = behind;
    } else {
      const mg = await runGit(['merge', '--ff-only', `origin/${branch}`], repoPath);
      step('快进到远端', mg.code === 0, `${behind} 个提交`);
      report.pulled = mg.code === 0 ? behind : 0;
    }
  } else {
    step('快进到远端', true, '远端没有新提交');
  }

  // 4. 推送
  const cnt = await runGit(['rev-list', '--count', `origin/${branch}..HEAD`], repoPath);
  const toPush = cnt.code === 0 ? parseInt(cnt.out.trim() || '0', 10) || 0 : 0;
  if (toPush) {
    const ps = await runGit(['push', 'origin', `HEAD:${branch}`], repoPath, { token, timeout: 180000 });
    if (!step('推送到远端', ps.code === 0, ps.code ? ps.err : `${toPush} 个提交`)) {
      report.error = ps.err || 'push 失败';
      return report;
    }
    report.pushed = toPush;
  } else {
    step('推送到远端', true, '没有新提交');
  }

  const cfg = store.loadConfig();
  cfg.last_sync = Math.floor(Date.now() / 1000);
  store.saveConfig(cfg);
  report.ok = true;
  return report;
}

module.exports = { setGitBin, findGit, runGit, repoState, cloneRepo, syncRepo };
