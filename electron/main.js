'use strict';
/**
 * Electron 主进程：窗口 + 内置 HTTP 服务 + 单实例 + 窗口状态记忆。
 * 服务端不再作为子进程存在，退出时随进程一起结束，不存在孤儿进程问题。
 */
const { app, BrowserWindow, Menu, dialog, safeStorage, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const store = require('../server/store');
const git = require('../server/git');
const { createServer } = require('../server/http');

const APP_NAME = 'Pile';
const isDev = !app.isPackaged;

app.setName(APP_NAME);

// 数据目录（便携版：所有数据都在程序目录的 data 下）
//   1. PILE_DATA / NOTES_READER_DATA 环境变量优先（调试、多实例）
//   2. 打包后：<exe 所在目录>\data          ← 整个文件夹拷走就是搬家
//   3. 开发（未打包）：%APPDATA%\Pile      ← 不往源码目录里写东西
function resolveDataDir() {
  const override = process.env.PILE_DATA || process.env.NOTES_READER_DATA;
  if (override) return path.resolve(override);
  if (app.isPackaged) return path.join(path.dirname(process.execPath), 'data');
  return path.join(app.getPath('appData'), APP_NAME);
}

const DATA_DIR = resolveDataDir();
ensureDataWritable();
migrateLegacyDataDir();

// Chromium 自己的缓存（Cache/GPUCache/Local Storage）放到子目录，不要和笔记数据混在一起
app.setPath('userData', path.join(DATA_DIR, 'chromium'));

/**
 * 便携化的第一步：确认数据目录真的能写。
 * 写不进去（Program Files、只读 U 盘、被安全软件锁住）就直接说清楚并退出，
 * 否则会出现「界面能用但什么都不保存」这种最难查的状态。
 *
 * 注意：showErrorBox 不会自动换行，宽度按最长的一行撑开，所以这里自己按字符数折行，
 * 路径太长就中间省略，保证中文提示不会被裁掉。
 */
function ensureDataWritable() {
  const probe = path.join(DATA_DIR, '.write-probe');
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
  } catch (e) {
    const shortPath = DATA_DIR.length > 48
      ? DATA_DIR.slice(0, 22) + '…' + DATA_DIR.slice(-22)
      : DATA_DIR;
    const lines = [
      'Pile 无法写入数据目录',
      '',
      '这个文件夹不能保存书架和配置。',
      `目录：${shortPath}`,
      `原因：${(e && (e.code || e.message)) || '未知'}`,
      '',
      '请把整个 Pile 文件夹放到可写的位置',
      '（例如 D:\\Pile 或 U 盘），不要放在',
      'C:\\Program Files 这类目录里再启动。',
    ];
    const msg = lines.join('\n');
    try { dialog.showErrorBox('Pile', msg); } catch { /* 没有 GUI 时忽略 */ }
    app.exit(1);
  }
}

/**
 * 把老版本的数据搬进当前数据目录，用户不用重新连一次仓库。
 * 来源：%APPDATA%\笔记阅读器（Electron 早期版）、%APPDATA%\Pile（安装版）。
 * 只在当前目录还没有 books.json 时搬，绝不覆盖已有数据。
 */
function migrateLegacyDataDir() {
  if (fs.existsSync(path.join(DATA_DIR, 'books.json'))) return;
  const sources = [
    path.join(app.getPath('appData'), '笔记阅读器'),
    path.join(app.getPath('appData'), APP_NAME),
  ].filter((p) => path.resolve(p) !== path.resolve(DATA_DIR) && fs.existsSync(p));
  for (const legacy of sources) {
    try {
      if (!fs.existsSync(path.join(legacy, 'books.json'))) continue;
      fs.mkdirSync(DATA_DIR, { recursive: true });
      for (const f of ['books.json', 'config.json', 'window-state.json']) {
        const src = path.join(legacy, f);
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(DATA_DIR, f));
      }
      const logsSrc = path.join(legacy, 'logs');
      const logsDst = path.join(DATA_DIR, 'logs');
      if (fs.existsSync(logsSrc)) {
        fs.mkdirSync(logsDst, { recursive: true });
        for (const f of fs.readdirSync(logsSrc)) {
          try { fs.copyFileSync(path.join(logsSrc, f), path.join(logsDst, f)); } catch { /* ignore */ }
        }
      }
      return; // 搬完一个来源就停
    } catch { /* 迁移失败不影响启动 */ }
  }
}

const STATIC_DIR = path.join(__dirname, '..', 'static');
const STATE_FILE = path.join(DATA_DIR, 'window-state.json');
const LOG_FILE = path.join(DATA_DIR, 'logs', 'app.log');

let mainWindow = null;
let httpServer = null;
let serverUrl = '';

// ---------------------------------------------------------------- 日志
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch { /* ignore */ }
}
function ensureDirs() {
  fs.mkdirSync(path.join(DATA_DIR, 'logs'), { recursive: true });
  // Pile 只管自己克隆出来的仓库；trash 存「丢弃本地改动」前备份的 patch
  fs.mkdirSync(path.join(DATA_DIR, 'repos'), { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, 'trash'), { recursive: true });
}
process.on('uncaughtException', (e) => log('uncaughtException:', (e && e.stack) || String(e)));
process.on('unhandledRejection', (e) => log('unhandledRejection:', (e && e.stack) || String(e)));

// ---------------------------------------------------------------- 旧版 token 迁移
/**
 * Python 版把 token 用 ctypes 直接调 DPAPI 加密后 base64 存盘；
 * safeStorage 的密文前面带 "v10"，解不了旧数据。这里用系统自带的 PowerShell
 * 走 .NET ProtectedData 解一次旧 blob，再用 safeStorage 重新加密，避免用户重填 token。
 */
function migrateLegacyToken() {
  const cfg = store.loadConfig();
  const blob = cfg.token_blob;
  if (!blob) return;
  try {
    const plain = safeStorage.decryptString(Buffer.from(blob, 'base64'));
    if (plain) return; // 已经是 safeStorage 格式
  } catch { /* 需要迁移 */ }

  try {
    const script = [
      'Add-Type -AssemblyName System.Security;',
      `$b=[Convert]::FromBase64String('${blob.replace(/'/g, "''")}');`,
      "$p=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser');",
      '$s=[System.Text.Encoding]::UTF8.GetString($p);$s',
    ].join(' ');
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', timeout: 20000, windowsHide: true,
    }).trim();
    if (out) {
      store.setToken(out);
      log('legacy token migrated to safeStorage');
    }
  } catch (e) {
    log('legacy token migration failed:', String(e && e.message));
  }
}

// ---------------------------------------------------------------- 窗口状态
function loadWindowState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveWindowState(win) {
  try {
    const b = win.getNormalBounds();
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      width: b.width, height: b.height, x: b.x, y: b.y, maximized: win.isMaximized(),
    }, null, 1), 'utf8');
  } catch (e) { log('save window state failed:', String(e && e.message)); }
}

function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        { label: '打开数据目录', click: () => shell.openPath(DATA_DIR) },
        { type: 'separator' },
        { label: '退出', role: 'quit' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '重新加载', role: 'reload' },
        { label: '开发者工具', role: 'toggleDevTools' },
        { type: 'separator' },
        { label: '放大', role: 'zoomIn' },
        { label: '缩小', role: 'zoomOut' },
        { label: '还原', role: 'resetZoom' },
        { type: 'separator' },
        { label: '全屏', role: 'togglefullscreen' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: `关于${APP_NAME}`,
              message: `${APP_NAME} ${app.getVersion()}`,
              detail: `Pile：把散落在各个仓库和本地目录里的 Markdown 笔记聚到一个书架。\n数据目录：${DATA_DIR}`,
              buttons: ['好'],
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------- 服务
function startServer() {
  return new Promise((resolve, reject) => {
    httpServer = createServer({ staticDir: STATIC_DIR });
    httpServer.on('error', reject);
    const fixedPort = Number(process.env.NOTES_READER_PORT || 0);
    httpServer.listen(fixedPort, '127.0.0.1', () => {
      const { port } = httpServer.address();
      serverUrl = `http://127.0.0.1:${port}/`;
      log(`http server listening on ${serverUrl}`);
      resolve(serverUrl);
    });
  });
}

function createWindow() {
  const st = loadWindowState();
  mainWindow = new BrowserWindow({
    width: st.width || 1280,
    height: st.height || 860,
    x: st.x,
    y: st.y,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#ffffff',
    title: APP_NAME,
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      devTools: true,
    },
  });

  if (st.maximized) mainWindow.maximize();

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (isDev && process.env.NOTES_READER_OPEN_DEVTOOLS) mainWindow.webContents.openDevTools({ mode: 'detach' });
    // 自动化验收：截图后自动退出
    if (process.env.NOTES_READER_SCREENSHOT) {
      const target = process.env.NOTES_READER_SCREENSHOT;
      const wait = Number(process.env.NOTES_READER_SHOT_DELAY || 2500);
      setTimeout(async () => {
        try {
          const img = await mainWindow.webContents.capturePage();
          fs.writeFileSync(target, img.toPNG());
          log('screenshot saved:', target);
        } catch (e) {
          log('screenshot failed:', String(e && e.message));
        }
        app.quit();
      }, wait);
    }
  });

  // 外链走系统浏览器，窗口内不允许导航到任何外部站点
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(serverUrl)) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });
  mainWindow.webContents.on('render-process-gone', (_e, d) => log('renderer gone:', JSON.stringify(d)));

  let timer = null;
  const remember = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { if (mainWindow && !mainWindow.isDestroyed()) saveWindowState(mainWindow); }, 400);
  };
  mainWindow.on('resize', remember);
  mainWindow.on('move', remember);
  mainWindow.on('close', () => { if (mainWindow && !mainWindow.isDestroyed()) saveWindowState(mainWindow); });
  mainWindow.on('closed', () => { mainWindow = null; });

  // 允许用 NOTES_READER_PATH 直接打开某个路由（自动化截图 / 调试用）
  const rawPath = process.env.NOTES_READER_PATH || '/';
  const initialPath = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  mainWindow.loadURL(new URL(initialPath, serverUrl).toString());
  return mainWindow;
}

// ---------------------------------------------------------------- 启动
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    ensureDirs();
    log(`starting v${app.getVersion()} packaged=${app.isPackaged} data=${DATA_DIR}`);

    store.setDataDir(DATA_DIR);
    if (safeStorage.isEncryptionAvailable()) {
      store.setCrypto({
        encrypt: (plain) => safeStorage.encryptString(plain.toString('utf8')),
        decrypt: (buf) => safeStorage.decryptString(buf),
      });
    } else {
      log('safeStorage 不可用：token 将不会被持久化');
    }
    migrateLegacyToken();

    // 没有书单也没有旧配置时，给一个空书单文件，前端会显示「添加仓库」
    if (!fs.existsSync(store.booksPath())) {
      fs.writeFileSync(store.booksPath(), JSON.stringify({ books: [] }, null, 1), 'utf8');
    }

    buildMenu();
    try {
      await startServer();
    } catch (e) {
      dialog.showErrorBox('启动失败', `本地服务无法启动：${(e && e.message) || e}`);
      app.quit();
      return;
    }
    createWindow();
  });

  app.on('window-all-closed', () => { app.quit(); });

  app.on('before-quit', () => {
    if (mainWindow && !mainWindow.isDestroyed()) saveWindowState(mainWindow);
    if (httpServer) { try { httpServer.close(); } catch { /* ignore */ } }
    log('bye');
  });
}
