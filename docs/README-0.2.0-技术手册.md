> **归档说明**：本文是 Pile 0.2.0 时期的技术手册（构建、接口、目录结构、排障）。
> 自 0.2.0 起仓库首页改为对外介绍（见根目录 `README.md`），本文内容之后会系统整理进 `docs/` 下的专题文档，在整理完成前仍以本文为准。

# Pile（桌面版）

把 GitHub 仓库当笔记库的本地阅读器。独立窗口运行，不依赖浏览器；自带 git，不需要用户另外装 Git。

![书架](screenshots/shelf.png)

![阅读](screenshots/reader.png)

---

## 这是什么

把散落在不同 GitHub 仓库和本地目录里的 Markdown 笔记，聚到同一个书架上读。

Pile 对仓库是**只读**的：它只会克隆和拉取（`fetch` + 快进），不会提交、不会推送、也不会改写你的仓库。

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
| 修订版本（0.2.**1**） | 只修 bug、调样式、改文案 | 修安装器、修更新提示 |

约定：
- 每个能装到机器上验收的构建都往上加一个修订号，不重复用同一个号。
- 产物名固定为 `Pile-<版本>-win-x64.zip`（便携版）；发布时给 git 打 `v<版本>` 标签。
- 0.x 期间不承诺数据格式兼容；真要改 `books.json` 结构时，程序会读旧格式并自动转换，并记一条日志。

## 安装：解压即用

下载 `Pile-0.2.0-win-x64.zip`，解压到一个**可写**的位置（`D:\Pile`、U 盘、桌面都行），双击 `Pile.exe`。

- **不写注册表、不装服务、不需要管理员权限**，删掉文件夹就是卸载
- 所有数据都在同目录的 `data\` 里：书架、配置、token、已下载的仓库、日志
- 想搬家/换电脑：整个文件夹拷走即可，书架和配置跟着走
- 同一个文件夹只能开一个窗口；不同文件夹的副本可以同时开
- **不要放在 `C:\Program Files`** 这类需要管理员权限的位置：程序目录写不进去时，Pile 会明确提示并退出（不会偷偷把数据写到别处）

体积参考：zip 约 149 MB，解压后约 418 MB（Electron 运行时 + 精简后的 PortableGit 108 MB）。

> 旧版本（0.1.x 安装包）升级过来：首次启动会把 `%APPDATA%\Pile` 里的 `books.json` / `config.json` 复制到 `data\`，不需要重新连仓库。原来的 `%APPDATA%\Pile` 不会被删除，确认新版本没问题后可以自己删。

---

## 第一次用

1. 打开软件 → 书架页面 → 右上角 **⚙**
2. 填仓库地址，比如 `https://github.com/你的账号/notes.git`
   - 私有库：填一个 **Fine-grained PAT**，仓库权限只勾 `Contents: Read-only`
   - 会自动 clone 到 `data\repos\<书 id>`（Pile 自己管这个目录）
   - 已经有本地 clone 的：直接填那个本地目录（按「外部仓库」处理，只读浏览、不自动更新）
3. 保存后书架就出现一本书，点开就能读
4. 右上角 **刷新**：从远端拉取最新内容（只有拉取，没有上传）

---

## 书架 = books.json

书架上的书不是扫出来的，是手写的清单，放在程序目录的 `data\books.json`（菜单 **文件 → 打开数据目录** 直接跳过去）。

> 从旧版本升级上来的（0.1.x 安装版或更早的「笔记阅读器」），首次启动会把旧目录里的 `books.json`、`config.json`、`window-state.json` 复制到 `data\`，不用重新连仓库；旧目录可以自己删。

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

同一个仓库可以有多本书（不同 `dir`）。

书的三种来源，由字段自动判定：

| 写了什么 | 类型 | 行为 |
| --- | --- | --- |
| `remote` | 托管仓库 | 克隆到 `data\repos\<id>`，打开时自动拉取 |
| `repo` 且路径在 `repos\` 下 | 托管仓库 | 同上 |
| `repo` 且路径在别处 | 外部仓库 | 只读浏览，不联网、不改动、不更新 |
| `local` | 本地目录 | 纯静态只读，不需要也不需要更新 |
书架**只展示，不在界面里增删**——想加书就编辑 `books.json`，保存后刷新界面（`Ctrl+R`）。

---

## 只读：只会拉取，不会上传

Pile 里没有「上传」「提交」「推送」这些能力，代码里也没有任何 `git add / commit / push` 调用。

| 步骤 | 命令 | 说明 |
| --- | --- | --- |
| 0 堵死推送 | `git config remote.origin.pushurl https://push.disabled/pile` | 克隆完立刻写本地配置，之后任何 push 都会失败；每次更新前再复核一次 |
| 1 检查本地改动 | `git status --porcelain` | 有改动就停下，问你要不要丢弃 |
| 2 拉取 | `git fetch origin` | 只更新远端引用，不动工作区 |
| 3 快进 | `git merge --ff-only origin/<branch>` | 只做快进，不产生合并提交、不改写历史 |
| 4 丢弃（可选） | `git diff HEAD > trash/*.patch` + `git reset --hard origin/<branch>` | 只有你点「丢弃改动并更新」才会执行，且先把改动备份成 patch |

四条硬规矩：

1. **不会推送**，也推不出去：pushurl 指向无效地址，源码里没有 push 调用
2. **不会替你提交**：本地改动保留原样，要么继续留着，要么你明确选择丢弃
3. **丢弃前先备份**：被丢弃的改动写成 patch，放在数据目录的 `trash\` 里
4. **只碰自己的目录**：Pile 克隆出来的仓库在 `data\repos\<书 id>`；`books.json` 里指向别处的仓库按「外部仓库」处理，只读浏览、不联网、不改动

更新时机：打开一本书时后台拉一次（同一本书 5 分钟内不重复），顶栏「刷新」按钮随时手动拉。
本地目录书（没有 git 的那种）是纯静态只读，没有更新按钮。

Token 建议：私有仓库用细粒度 PAT，只勾 **Contents: Read-only** 就够了——Pile 不需要写权限。

---

## 数据与日志

全部在程序目录的 `data\` 下（便携：拷走文件夹就是搬家）：

| 路径 | 内容 |
| --- | --- |
| `data\books.json` | 书架清单（一本书一段，可手工编辑） |
| `data\config.json` | 配置、上次更新时间、加密后的 token（safeStorage / DPAPI，只在本机本账户可解） |
| `data\window-state.json` | 窗口大小和位置 |
| `data\repos\` | 从远端克隆下来的仓库 |
| `data\trash\` | 丢弃本地改动前自动备份的 patch |
| `data\logs\app.log` | 启动、端口、错误日志 |
| `data\chromium\` | 界面缓存（Chromium），可以整个删掉，不影响笔记 |

调试时可以用环境变量 `PILE_DATA` 把数据目录指到别处（优先级最高）。
没打包（`pnpm start`）时数据默认落在 `%APPDATA%\Pile`，不会污染源码目录。

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

## 打包便携版（zip）

```bash
# 国内网络必须先设这三个镜像变量
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
export CSC_IDENTITY_AUTO_DISCOVERY=false   # 不做代码签名

pnpm run dist            # 便携版：release/Pile-<版本>-win-x64.zip
pnpm run dist:installer  # 需要安装包时（沿用 build/installer.nsh 的结束进程钩子）
```

zip 约 149 MB，解压后约 418 MB（Electron 运行时 + 精简后的 PortableGit）。打包时 `extraFiles` 会把 `build/使用说明.txt` 放到 zip 根目录，和 `Pile.exe` 并排（`extraResources` 里只放 git）。

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
| `POST /api/refresh?book=` | 单向更新（fetch + 快进）；本地脏时返回 409 与文件列表 |
| `POST /api/refresh?book=`（body `{"discard":true}`） | 备份 patch 后丢弃本地改动，再快进 |
| `POST /api/clone` | 克隆到 `repos\<id>` 并登记到书架 |
| `POST /api/add-local` | 把本地目录登记成只读的书 |

---

## 目录结构

```
desktop/
├── electron/main.js     主进程：窗口、单实例、窗口状态、菜单、启动内置服务
├── server/http.js       路由、静态文件、CSP
├── server/git.js        git 封装（状态、clone、单向更新）
├── server/docs.js       目录树、Markdown 读取、搜索
├── server/store.js      配置、书架、token（safeStorage）
├── static/              书架与阅读界面（原生 JS，无框架）
├── build/               图标、打包后处理
└── git/                 精简版 PortableGit
```

---

## 已知限制

- **纯只读**：不能在软件里编辑笔记，也不会把任何内容写回仓库（这正是设计目标）
- `books.json` 里的书还是手写的（软件可以帮你克隆/添加，删除请编辑文件）
- 书架是手写清单，界面里不能增删书
- 不显示阅读进度，只记住每本书最后打开的位置
- 不开放局域网访问（只 `127.0.0.1`）
- **没有代码签名**：从网上下载的 zip 展开后，首次运行 `Pile.exe` 时 SmartScreen 可能提示，选「更多信息 → 仍要运行」
- 便携版必须放在可写目录：`C:\Program Files`、只读光盘/DVD 会直接提示并退出

---

## 排障

| 现象 | 处理 |
| --- | --- |
| 双击没反应 / 白屏 | 看程序目录下 `data\logs\app.log` |
| 启动弹「Pile 无法写入数据目录」 | 文件夹不可写（Program Files、只读介质、被安全软件锁住）。换到 `D:\Pile` 这类普通目录 |
| 换了个文件夹后书架空了 | 便携版数据跟着文件夹走：要把 `data\` 一起搬，只拷 `Pile.exe` 是不行的 |
| 启动第二个副本时第一个窗口跳出来 | 同一份 `data\` 只能开一个窗口；想同时开两份就把整个文件夹复制一份 |
| 更新报「仓库没有配置 origin 远端」 | `books.json` 的 `repo` 必须是 git 仓库且有 origin |
| 私有库 clone 失败 | PAT 过期或没有 `Contents` 权限；重新在 ⚙ 里填 |
| 更新报「本地有改动」 | 点「丢弃改动并更新」会把改动备份成 patch 再对齐远端；想保留就去仓库里自己处理 |
| 更新报「这是你自己的仓库目录」 | 该书的 `repo` 指向 Pile 管理目录之外；想自动更新就删掉 `repo` 换成 `remote`，让 Pile 克隆一份 |
| 端口冲突 | 设 `PILE_PORT` 换一个端口 |

> 本机开发注记：`F:\p1`（DSH 工作区）里的文件带**低完整性级别（Low IL）**标签，从该目录启动的进程也是 Low IL —— 因此 Electron 会在 Chromium 初始化时崩（`0xC0000005`），NSIS 安装器也无法结束 Medium IL 的程序。把 Electron 运行时和安装包都放到 `C:` 盘（或桌面 / 下载目录）执行即可，打包产物放在 `F:` 没问题。
