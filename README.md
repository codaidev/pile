# Pile（桌面版）

把 GitHub 仓库当笔记库的本地阅读器。独立窗口运行，不依赖浏览器；自带 git，不需要用户另外装 Git。

![书架](screenshots/app-shelf.png)

---

## 这是什么

不是网盘同步，而是**分布式合并**：本地 clone 一份仓库，改完两边各自提交，同步时用 rebase 把两条历史接起来，冲突就停下来交给人处理。

- 界面是「书架」：一门课 / 一个专题 = 一本书，点进去才是阅读界面（左侧目录树、中间正文、右侧大纲）
- 后端是内置的 HTTP 服务，只监听 `127.0.0.1`（不开放局域网）
- 渲染走 marked + DOMPurify 消毒，不会执行笔记里的脚本
- Token 用 Windows DPAPI（Electron `safeStorage`）加密，只有当前 Windows 用户能解开

---

## 版本号规则

从 0.1.0 开始用语义化版本 `主版本.次版本.修订号`，前 0.x 阶段表示「还在长」，随时可能调整：

| 位 | 什么时候加 | 例子 |
| --- | --- | --- |
| 主版本（1.0.0） | 你愿意把它推荐给别人、界面和数据格式都稳定下来时 | `1.0.0` = 第一个正式版 |
| 次版本（0.**2**.0） | 加了一批新功能 | 书架 → 全文搜索范围选择、编辑模式 |
| 修订版本（0.1.**1**） | 只修 bug、调样式、改文案 | 修安装器、修同步冲突提示 |

约定：
- 每个能装到机器上验收的构建都往上加一个修订号，不重复用同一个号。
- 安装包文件名固定为 `pile-<版本>-setup.exe`，发布时给 git 打 `v<版本>` 标签。
- 0.x 期间不承诺数据格式兼容；真要改 `books.json` 结构时，程序会读旧格式并自动转换，并记一条日志。

## 安装

双击安装包（`pile-0.1.0-setup.exe`）。

> **别在工作区目录里双击**：像 `F:\p1` 这类被标记为「低完整性级别」的目录，从里面启动的程序没有权限结束已打开的窗口，安装器会提示「无法结束正在运行的 Pile」。把安装包复制到桌面或「下载」文件夹再运行即可。

- 默认**只为当前用户安装**（装到 `%LOCALAPPDATA%\Programs\pile`），不需要管理员权限
- 安装时可以改目录；会创建桌面和开始菜单快捷方式「Pile」
- 卸载：Windows「设置 → 应用」，或安装目录下的 `Uninstall Pile.exe`。**只删程序，不删笔记**
- 升级安装时如果程序还开着，安装器会**自动结束它**（`build/installer.nsh` 里的 `customInit` 钩子），不需要手动关窗口
- 同版本覆盖安装也可以：先结束旧进程再就地重装，不会报 `Failed to uninstall ... : 2`

体积参考：安装包约 149 MB，安装后约 418 MB（Electron 运行时 + 精简后的 PortableGit 108 MB）。

---

## 第一次用

1. 打开软件 → 书架页面 → 右上角 **⚙**
2. 填仓库地址，比如 `https://github.com/你的账号/notes.git`
   - 私有库：填一个 **Fine-grained PAT**，仓库权限勾 `Contents: Read and write`
   - 安装时会自动 clone 到 `%USERPROFILE%\notes\<仓库名>`，也可以自己指定目录
   - 已经有本地 clone 的：直接填那个本地路径
3. 保存后书架就出现一本书，点开就能读
4. 右上角 **同步**：提交本地改动 → 拉取远端 → 变基或快进 → 推送

---

## 书架 = books.json

书架上的书不是扫出来的，是手写的清单，放在 `%APPDATA%\Pile\books.json`（菜单 **文件 → 打开数据目录**）。

> 从旧名字「笔记阅读器」升级上来的，第一次启动会自动把 `%APPDATA%\笔记阅读器` 里的 `books.json`、`config.json`、`window-state.json` 复制到 `%APPDATA%\Pile`，不用重新连仓库；旧目录可以自己删。

```json
[
  {
    "id": "genai-2026",
    "title": "2026 南京大学 生成式软件工程",
    "subtitle": "蒋炎岩 · 12 集",
    "repo": "F:\\notes\\learning-notes",
    "remote": "https://github.com/codaidev/learning-notes.git",
    "dir": "docs/courses/2026-nju-genai-se",
    "cover": "#3b6ef2"
  }
]
```

| 字段 | 说明 |
| --- | --- |
| `id` | 唯一标识，出现在地址里（`/read/<id>/<path>`） |
| `title` / `subtitle` | 卡片上的标题和副标题 |
| `repo` | 本地仓库路径；`remote` 是它的远端地址（用于显示和 clone） |
| `dir` | 这本书对应仓库里的哪个子目录；**省略就表示整个仓库是一本书** |
| `cover` | 封面主色（CSS 颜色），省略用默认蓝 |

同一个仓库可以有多本书（不同 `dir`），同步时按仓库去重，只跑一次。
书架**只展示，不在界面里增删**——想加书就编辑 `books.json`，保存后刷新界面（`Ctrl+R`）。

---

## 同步到底做了什么

| 步骤 | 命令 | 说明 |
| --- | --- | --- |
| 1 提交本地改动 | `git add -A` + `git commit` | 有改动先落一个提交，避免任何情况下丢内容 |
| 2 拉取 | `git fetch origin` | 只更新远端引用，不动工作区 |
| 3 合并 | `git rebase origin/<branch>`，或 `git merge --ff-only` | 两边都有新提交才 rebase；只有远端有新提交就快进 |
| 4 推送 | `git push origin HEAD:<branch>` | 没有待推提交就跳过 |

三条硬规矩：

1. **绝不 force push**，push 永远不会覆盖别人的提交
2. **冲突就回滚**：rebase 失败先 `git rebase --abort` 回到同步前状态，再把冲突文件列出来，让人手工处理
3. **本地改动先提交**，同步失败也不会丢未提交的内容

提交身份不用你配：应用自己做提交和变基时带 `-c user.name=Pile -c user.email=pile@localhost`，不会去读、也不会改你的全局 git 配置。

---

## 数据与日志

| 路径 | 内容 |
| --- | --- |
| `%APPDATA%\Pile\books.json` | 书架清单 |
| `%APPDATA%\Pile\config.json` | 仓库路径、上次同步时间、加密后的 token |
| `%APPDATA%\Pile\window-state.json` | 窗口大小和位置 |
| `%APPDATA%\Pile\logs\app.log` | 启动、端口、错误日志 |
| `%APPDATA%\Pile\chromium\` | 界面自身的缓存（Chromium 用），可以整个删掉，不影响笔记 |

开发时可以用环境变量 `PILE_DATA` 把数据目录指到别处。

---

## 从源码跑起来

需要 Node 22+ 和 Windows（Electron 45 不支持更老的系统）。

```bash
git clone https://github.com/codaidev/pile.git
cd pile

# 1) 依赖
pnpm install

# 2) 打包内嵌的 git（约 60 MB 下载，解出来约 106 MB）
pnpm run fetch-git

# 3) 开发模式跑起来
pnpm start

# 只跑 HTTP 服务，不起窗口（方便 curl 测接口）
node dev-run.js 7799
```

`git/` 不进仓库：它是一份精简过的 PortableGit（原版 412 MB → 106 MB，删掉 `usr/`、文档、GUI 工具、.NET/Avalonia/SkiaSharp、tcl/tk 等，只留 clone/fetch/rebase/push 需要的东西）。`pnpm run fetch-git` 会从 npmmirror 下载官方自解压包，解压到 `git/` 后自动做这套精简，并跑一次 `git --version` 自检。打包时通过 `extraResources` 放进 `resources/git/`。

## 打包安装包

```bash
# 国内网络必须先设这三个镜像变量
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
export CSC_IDENTITY_AUTO_DISCOVERY=false   # 不做代码签名

pnpm run dist        # 产物在 release/pile-<版本>-setup.exe
```

安装包 149 MB，装完 418 MB（Electron 运行时 + 精简后的 PortableGit）。

两个踩过的坑：

- pnpm 11 默认拒绝安装「发布不满 24 小时」的包。如果 `pnpm install` 报 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`，在 `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 里加上被拦的包（本仓库已经加过 `electron@45.4.1`），或临时加 `--config.minimumReleaseAge=0`。
- electron-builder 打包时会自己调 `pnpm list` 收集生产依赖；如果你的 PATH 上没有 `pnpm` 可执行文件（比如只有 pnpm.mjs），会报 `spawn EPERM`。做一个 `pnpm.cmd` 垫片指向 `node pnpm.mjs` 即可。

> 另外，如果你在带「低完整性级别」标签的目录里开发（一些沙箱会这样标记工作目录），Electron 可能启动即崩、`node_modules` 里建不了链接：把源码复制到 `C:\` 下的普通目录再装依赖和打包。

## HTTP 接口

界面全部走这些接口，端口随机（`PILE_PORT` 可固定），只绑 `127.0.0.1`。

| 接口 | 说明 |
| --- | --- |
| `GET /api/ping` | 存活检查 |
| `GET /api/library` | 书架列表（不跑 git，秒回） |
| `GET /api/state?book=` | 仓库状态：分支、ahead/behind、改动文件、HEAD |
| `GET /api/tree?book=` | 目录树（只列 `.md`） |
| `GET /api/doc?book=&path=` | 单篇 Markdown + front-matter |
| `GET /api/search?book=&q=` | 全库全文搜索（子串匹配，带上下文） |
| `POST /api/setup` | 绑定本地仓库路径 |
| `POST /api/clone` | 从远端 clone 到本地 |
| `POST /api/token` | 保存 / 清除 PAT |
| `POST /api/sync` | 执行同步，返回四步报告 |

---

## 目录结构

```
desktop/
├── electron/main.js     主进程：窗口、单实例、窗口状态、菜单、启动内置服务
├── server/http.js       路由、静态文件、CSP
├── server/git.js        git 封装（状态、clone、同步）
├── server/docs.js       目录树、Markdown 读取、搜索
├── server/store.js      配置、书架、token（safeStorage）
├── static/              书架与阅读界面（原生 JS，无框架）
├── build/               图标、打包后处理
└── git/                 精简版 PortableGit
```

---

## 已知限制

- **只读阅读 + 同步**，不能在软件里编辑笔记（用你的编辑器改，回来点同步）
- 书架是手写清单，界面里不能增删书
- 不显示阅读进度，只记住每本书最后打开的位置
- 不开放局域网访问（只 `127.0.0.1`）
- 安装包**没有代码签名**：首次运行 Windows SmartScreen 可能提示，选「更多信息 → 仍要运行」

---

## 排障

| 现象 | 处理 |
| --- | --- |
| 双击没反应 / 白屏 | 看 `%APPDATA%\Pile\logs\app.log` |
| 安装时提示「无法结束正在运行的 Pile」 | 安装包放在了**低完整性级别**目录里（如 `F:\p1` 这类沙箱工作区）。把安装包复制到桌面或「下载」文件夹再双击 |
| 安装时提示「无法关闭」或 `Failed to uninstall ... : 2` | 旧版本安装器（1.0.1 及以前）没有结束进程的钩子：任务管理器结束 `Pile.exe` 后重跑，或直接用 0.1.0 安装包覆盖 |
| 同步报「仓库没有配置 origin 远端」 | `books.json` 的 `dir` 必须在 git 仓库里，且仓库有 origin |
| 私有库 clone 失败 | PAT 过期或没有 `Contents` 权限；重新在 ⚙ 里填 |
| 提示「存在冲突，需要手工解决」 | 打开仓库，`git status` 看冲突文件，改好后重新同步 |
| 端口冲突 | 设 `PILE_PORT` 换一个端口 |

> 本机开发注记：`F:\p1`（DSH 工作区）里的文件带**低完整性级别（Low IL）**标签，从该目录启动的进程也是 Low IL —— 因此 Electron 会在 Chromium 初始化时崩（`0xC0000005`），NSIS 安装器也无法结束 Medium IL 的程序。把 Electron 运行时和安装包都放到 `C:` 盘（或桌面 / 下载目录）执行即可，打包产物放在 `F:` 没问题。
