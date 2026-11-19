#!/usr/bin/env node
/**
 * 下载官方 PortableGit 自解压包，解到项目下的 git/，再做精简。
 * 精简后约 108 MB（原版 412 MB），只保留 clone/fetch/rebase/push 需要的部分。
 *
 *   node scripts/fetch-git.mjs            # 已有 git/ 就跳过
 *   node scripts/fetch-git.mjs --force    # 强制重下
 */
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const GIT_VERSION = '2.56.1';
const GIT_URL = `https://registry.npmmirror.com/-/binary/git-for-windows/v${GIT_VERSION}.windows.1/PortableGit-${GIT_VERSION}-64-bit.7z.exe`;
const FALLBACK_URL = `https://github.com/git-for-windows/git/releases/download/v${GIT_VERSION}.windows.1/PortableGit-${GIT_VERSION}-64-bit.7z.exe`;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destDir = path.join(root, 'git');
const cacheDir = path.join(root, '.git-cache');
const archive = path.join(cacheDir, `PortableGit-${GIT_VERSION}-64-bit.7z.exe`);

function log(...a) { console.log('[fetch-git]', ...a); }

function download(url, file, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    https.get(url, { headers: { 'user-agent': 'pile-fetch-git' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return download(new URL(res.headers.location, url).toString(), file, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${url}`)); }
      const total = Number(res.headers['content-length'] || 0);
      let got = 0, lastPct = -1;
      const out = fs.createWriteStream(file);
      res.on('data', (chunk) => {
        got += chunk.length;
        if (total) {
          const pct = Math.floor((got / total) * 100);
          if (pct >= lastPct + 10) { lastPct = pct; log(`下载中 ${pct}% (${(got / 1048576).toFixed(0)} MB)`); }
        }
      });
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve(file)));
      out.on('error', reject);
    }).on('error', reject);
  });
}

function rm(p) { fs.rmSync(p, { recursive: true, force: true }); }

function walk(dir, fn) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) walk(fp, fn); else fn(fp);
  }
}

function trim(dir) {
  const ucrt = path.join(dir, 'ucrt64');
  // 1) 整个删：Unix 兼容层、文档、GUI 工具、perl 库
  for (const p of ['usr', 'mingw64/share/doc', 'ucrt64/share/doc', 'ucrt64/share/zoneinfo',
    'ucrt64/share/antiword', 'ucrt64/share/gitweb', 'ucrt64/share/git-gui', 'ucrt64/share/gitk',
    'ucrt64/share/perl5', 'mingw64/share/perl5']) rm(path.join(dir, p));

  // 2) ucrt64/bin 里只留这几个 exe
  const keepExe = new Set(['git.exe', 'git-upload-pack.exe', 'git-receive-pack.exe',
    'git-upload-archive.exe', 'git-askpass.exe']);
  const bin = path.join(ucrt, 'bin');
  if (fs.existsSync(bin)) {
    for (const name of fs.readdirSync(bin)) {
      if (name.toLowerCase().endsWith('.exe') && !keepExe.has(name.toLowerCase())) rm(path.join(bin, name));
    }
  }

  // 3) 清掉 .NET / Avalonia / SkiaSharp 等 GUI 依赖和调试符号
  // GUI 依赖（凭据管理器的 .NET/Avalonia 组件、SkiaSharp 画图、tcl/tk）全部删掉；
  // 只留 libcurl/libssl 这类 git 自己需要的 dll
  const junk = /^(lib)?(skiasharp|harfbuzzsharp)|^(system|microsoft)\.|^(msalruntime|avalonia|api-ms-|ucrtbase)|^tcl\d|^tk\d|^(github|gitlab|atlassian)\./i;
  for (const d of [path.join(ucrt, 'bin'), path.join(ucrt, 'libexec', 'git-core')]) {
    if (!fs.existsSync(d)) continue;
    for (const name of fs.readdirSync(d)) {
      const low = name.toLowerCase();
      if (low.endsWith('.pdb')) rm(path.join(d, name));
      else if (low.endsWith('.dll') && junk.test(name)) rm(path.join(d, name));
    }
  }
  walk(dir, (fp) => { if (fp.toLowerCase().endsWith('.pdb')) rm(fp); });
}

function sizeOf(dir) {
  let total = 0;
  walk(dir, (fp) => { try { total += fs.statSync(fp).size; } catch { /* ignore */ } });
  return (total / 1048576).toFixed(0);
}

async function main() {
  const force = process.argv.includes('--force');
  const gitExe = path.join(destDir, 'cmd', 'git.exe');
  if (fs.existsSync(gitExe) && !force) {
    log('已存在，跳过（要重下载加 --force）:', destDir);
    return;
  }
  fs.mkdirSync(cacheDir, { recursive: true });
  if (!fs.existsSync(archive) || force) {
    log('下载', GIT_URL);
    try { await download(GIT_URL, archive); }
    catch (e) { log('镜像失败，回退 GitHub：' + e.message); await download(FALLBACK_URL, archive); }
  } else {
    log('使用缓存', archive);
  }
  log('解压到', destDir);
  rm(destDir);
  const r = spawnSync(archive, ['-y', `-o${destDir}`], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('解压失败，退出码 ' + r.status);
  log('精简中…');
  trim(destDir);
  const v = spawnSync(gitExe, ['--version'], { encoding: 'utf8' });
  log('完成：', (v.stdout || '').trim(), '| 体积约', sizeOf(destDir), 'MB');
}

main().catch((e) => { console.error('[fetch-git] 失败：', e.message); process.exit(1); });
