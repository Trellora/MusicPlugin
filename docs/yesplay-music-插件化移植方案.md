# YesPlayMusic → Trellora 插件化移植方案（可行性 · 架构 · 路线图）

> 状态：`@experimental`（插件 API 未冻结，跟随 `plugins/README.md` 的稳定性承诺）
> 上游项目：[qier222/YesPlayMusic](https://github.com/qier222/YesPlayMusic)（MIT）
> 本文档是本移植任务的设计契约，结构对齐 `docs/notice-hub-插件化与日程适配方案.md`。
> 插件本体：[`plugins/yesplay-music/`](../plugins/yesplay-music/)

---

## 1. 背景与目标

目标是把 YesPlayMusic（一个基于 Vue + Electron 的网易云音乐第三方播放器）做成
Trellora 的"项目扩展"（即 Trellora 插件系统产物，见 [`plugins/README.md`](../plugins/README.md)），
要求：可安装、可维护、合规、可迭代。

需要注意的术语对齐：**Trellora 的"扩展"是插件系统（`plugin.json` + `main.js` +
PluginContext），不是浏览器扩展**。它没有 background/content script、没有弹窗页、
没有 CRX 打包；它的能力模型完全不同（详见 §4）。本方案所有设计都以
`plugins/sdk/trellora-plugin-sdk.d.ts` 的真实 API 面为准，不按浏览器扩展的心智模型臆造能力。

---

## 2. 结论摘要（TL;DR）

1. **全量移植（播放器界面 + 音频播放）在当前插件 API 下不可行**。插件运行在 Electron
   主进程，UI 能力只有 `ui.registerCommand`（侧栏/命令面板按钮，`execute` 在主进程执行），
   **没有自定义 UI 面板、没有用户输入界面、没有音频输出、没有向渲染进程推送状态的通道**。
   播放器是一个渲染进程 UI + 媒体播放问题，必须由宿主新增扩展点承载（§6.3 提案）。
2. **v0.1 可以落地一个高价值的"音乐伴侣"插件**：网易云公开榜单/搜索/歌词 → 聚合成
   "今日榜单速览"写入 Trellora 日程（`schedule:write`），带本地缓存与状态事件。
   该范围 100% 落在现有 API 内，无需改宿主一行代码。
3. **登录态（我的歌单、每日推荐、听歌排行）是 v0.2**：插件网络层已可发 https 请求，
   但 cookie/登录态的取得与安全存储需要设计（宿主 `safeStorage`，绝不落明文）。
4. **播放是 v0.3**，且**依赖宿主扩展点**（媒体播放 API + 面板承载），这是本移植的
   唯一硬阻塞项，也是需要产品决策的地方（§14）。
5. 合规基线：上游 MIT 署名保留（`LICENSE-UPSTREAM` + `NOTICE`）；不绕过付费、DRM、
   会员与地域限制；不采集用户数据；不硬编码任何密钥。**三不引入**：
   `@unblockneteasemusic`（LGPL + 灰色音源）、`@neteaseapireborn/api` /
   NeteaseCloudMusicApi 服务（deprecated/archived、上游许可证未核实）、
   realIP 伪造与伪装官方客户端参数（规避手段，不做）。
6. 上游是 **Vue 2 + Vue CLI 4 + Electron 13** 的停止维护工具链，**只移植业务逻辑
   （播放器状态机、LRC 解析、队列、br 映射），不移植其构建体系与 UI 组件**；UI 层
   按 Trellora React 宿主形态重写（或声明式面板重述，见 §6.3 P3）。

---

## 3. 上游仓库分析结论（YesPlayMusic）

> 本节事实来自对上游仓库（README / 源码 / LICENSE）的调研，逐项标注证据来源；
> 未核实处显式标注。移植实现不得基于猜测进行。

> 调研方法：GitHub API + raw 文件逐文件核实（2026-10-21）；证据为 GitHub 源码/README 链接。

### 3.1 技术栈（决定"搬什么、弃什么"）

| 项 | 结论 |
|---|---|
| 框架 | **Vue 2.6 + Vue CLI 4（webpack）+ Vuex 3 + vue-router 3**，选项式 API、非 TypeScript |
| 桌面壳 | **Electron 13**（`vue-cli-plugin-electron-builder`），Node engines 限定 14/16 |
| 音频 | **howler ^2.2.3**（html5 模式 = 底层 HTMLAudioElement） |
| 缓存 | Dexie（IndexedDB）四表：trackDetail/lyric/album/trackSources |
| UI | 无第三方 UI 库，22 个自研 Vue 组件 + 21 个页面；Sass + CSS 变量主题；vue-i18n 8 |
| 构建 | Vue CLI 4 / webpack4 / electron-builder 23 —— **工具链全部停止维护，不移植构建体系，只取源码逻辑** |

证据：[package.json](https://github.com/qier222/YesPlayMusic/blob/master/package.json)、
[src/utils/Player.js](https://github.com/qier222/YesPlayMusic/blob/master/src/utils/Player.js)、
[src/background.js](https://github.com/qier222/YesPlayMusic/blob/master/src/background.js)

> 另有 v2.0.0-alpha（R3PLAY）重写线（pnpm+turbo monorepo + TS + Tailwind），与 0.4.x
> 不同源，**未核实**，本方案以 master v0.4.11 为准。

### 3.2 API 与网络（合规敏感区）

- 接口来自 **NeteaseCloudMusicApi 系**（逆向 weapi/eapi 非官方 API）：Electron 版在主进程
  **内嵌 HTTP 服务**（`src/electron/services.js`，`@neteaseapireborn/api`，端口 10754）；
  Web 版走 `/api` 同域反代（Vercel rewrite / Nginx）。
- 登录：二维码（`/login/qr/key|create|check`）、手机/邮箱、`/login/refresh`；凭证是
  Cookie `MUSIC_U`（`src/api/auth.js`、`src/utils/auth.js`）。
- **上游还有 `realIP` 参数伪造（默认写死 211.161.244.70）与伪装官方客户端参数**
  （PR #2306，已并入 v0.4.9）——**本移植不实现这两类规避手段**（见 §11）。
- 证据：[src/api/](https://github.com/qier222/YesPlayMusic/tree/master/src/api)、
  [src/utils/request.js](https://github.com/qier222/YesPlayMusic/blob/master/src/utils/request.js)、
  [README](https://github.com/qier222/YesPlayMusic/blob/master/README.md)

### 3.3 播放器与歌词（可移植资产核心）

- `src/utils/Player.js`（约 900 行单例）：队列（`_list`/`_shuffledList`/`_playNextList` 插队）、
  循环模式、私人 FM 双曲目预取、播放进度/音量、Proxy 自动持久化（localStorage + IPC 同步托盘/MPRIS）。
- 音质：`src/api/track.js getMP3()` 的 `br` 映射（128k/192k/320k/flac）；未登录回退
  `https://music.163.com/song/media/outer/url?id=` 直链。
- 歌词：`src/utils/lyrics.js` 是**标准 LRC 行级时间戳**解析（`lyric`/`tlyric` 翻译/`romalrc`
  音译、二分插入排序）；**逐字歌词（yrc）上游没有**（需自研或引 AMLL 生态）。
- 证据：[src/utils/lyrics.js](https://github.com/qier222/YesPlayMusic/blob/master/src/utils/lyrics.js)、
  [src/api/track.js](https://github.com/qier222/YesPlayMusic/blob/master/src/api/track.js)

### 3.4 Electron 专属能力（替换难度，用于 §5 矩阵）

内嵌 NCM API 服务（中）、**UnblockMusic 灰色音源（`@unblockneteasemusic/rust-napi` 原生
模块，LGPL-3.0-or-later，版权灰区 → 本移植明确不移植）**、托盘/全局快捷键/Dock 菜单（中）、
Touch Bar 歌词（难/不可）、MPRIS + OSD Lyrics 桌面歌词（Linux 专属，难）、Discord RPC /
Last.fm scrobble（中）、自定义标题栏与窗口控制（中）、两级代理（中）、electron-store（易）。
**上游没有"本地音乐扫描"和"歌曲下载"模块**（全仓库树无对应实现，只有 Dexie 的歌曲
自动缓存），因此这两项无移植对象。

### 3.5 许可证与维护状态

- 本体 **MIT**（[LICENSE](https://github.com/qier222/YesPlayMusic/blob/master/LICENSE)，
  Copyright 2020-2023 qier222）；README 另有"仅供个人学习研究使用，禁止商业及非法用途"
  的使用限制声明 —— 与 MIT 并存，商业使用需自行评估。
- 依赖风险：`@unblockneteasemusic/rust-napi` **LGPL-3.0-or-later**（不引入，见 §11）；
  `@neteaseapireborn/api`（ISC）**npm 已 deprecated**，其上游
  `Binaryify/NeteaseCloudMusicApi` **已 archived**（2024-02 停更）且许可证**未核实** ——
  **本移植不引入该依赖**，改为最小化直连公开接口（§11）。
- 活跃度：master v0.4.11（2026-10-10 发版，此前 2024 底起长停更，README 宣布维护模式）；
  33.4k stars / 650 open issues。
- **已知风控实证**：issue [#2493](https://github.com/qier222/YesPlayMusic/issues/2493)
  （扫码登录 -462"请完成验证操作"/8821）、[#2311](https://github.com/qier222/YesPlayMusic/issues/2311)
  系列（登录后强制改密/账号冻结）、社区标准 workaround 是**导入网页登录后的 MUSIC_U Cookie**
  （issue #2398）。→ 登录链路（v0.2.5）风险高，且"Cookie 导入"同样属于 ToS 灰区，需产品决策。

### 3.6 上游移植难度矩阵（模块 × 可移植性 × 理由）

| 功能模块 | 可移植性 | 理由 |
|---|---|---|
| API 封装层 `src/api/*` | 中 | 接口面清晰，但直接受风控现状影响 |
| 内嵌 NCM API 服务 | 中 | 与"插件不起本地端口"的宿主约束冲突，应改进程内直调 |
| 登录（二维码/手机/邮箱/Cookie） | 中 | 链路现成但风控随时失效，必须 Cookie 导入兜底 |
| 播放引擎 `Player.js` + howler | 中 | 逻辑成熟，但耦合 window/localStorage/ipcRenderer，需剥离 |
| 播放队列/插队/私人 FM | 易 | 纯数据结构与状态机 |
| 歌词（LRC 行级+翻译+音译） | 易 | 纯函数；逐字歌词需自研 |
| 音质选择 | 易 | br 映射十来行 |
| 歌曲/歌词缓存（Dexie） | 易～中 | 换宿主存储即可 |
| UI 层（Vue 2 组件与页面） | 难 | 宿主是 React，只能搬交互/样式规范，页面重写 |
| UnblockMusic 灰色音源 | **不移植** | LGPL + 版权灰区 + 违反本方案合规红线 |
| 托盘/快捷键/窗口控制 | 中 | 宿主需有对应能力 |
| Touch Bar / MPRIS 桌面歌词 | 难/不可 | 平台绑定深 |
| 构建体系（Vue CLI 4 + Electron 13） | **不移植** | 工具链停止维护 |

---

## 4. Trellora 侧能力边界（依据真实代码）

以下全部来自本仓库当前实现（`electron/plugins/`、`plugins/sdk/`、`src/utils/plugins/`），
不是文档臆想。**这一节是可行性的裁决依据**。

### 4.1 插件运行模型

| 维度 | 现状 | 证据 |
|---|---|---|
| 运行位置 | Electron **主进程**（动态加载入口模块） | `electron/plugins/pluginLoader.ts` |
| 入口契约 | `activate(context)` / 可选 `deactivate()` | `plugins/sdk/trellora-plugin-sdk.d.ts` |
| 隔离沙箱 | **无**。插件与宿主同进程同权限；权限模型靠 context API 守卫，不拦 `require('node:fs')` | `pluginLoader.ts` + `pluginContext.ts` |
| UI 能力 | 仅 `ui.registerCommand`：渲染成侧栏/命令面板按钮，`execute` 在主进程执行 | `pluginContext.ts:108`、`src/utils/plugins/usePluginCommands.ts` |
| 用户输入 | **无**。命令没有参数输入框；`invokeCommand` 的 payload 由宿主提供，当前 UI 不传 | `electron/preload.ts:62` |
| 输出展示 | **无**。插件事件总线是主进程内 `Map`，渲染进程无法订阅；`listCommands` 每 10s 轮询是唯一反馈 | `pluginHost.ts:152-160`、`usePluginCommands.ts` |
| 音频/媒体 | **无任何 API** | `pluginTypes.ts` 全量核对 |
| 网络 | `network.fetch`：仅 https、公共域名、SSRF 防护、10s 超时 | `pluginContext.ts:130-140` |
| 文件 | `files.*`：仅插件自身 `storageDir`，防路径穿越 | `pluginContext.ts:112-128` |
| 日程 | `schedule.upsertItems/removeItems/listSource`：幂等 upsert、单次 ≤500 条 | `plugins/sdk/trellora-plugin-sdk.d.ts` |
| 配置 | `config.get` **当前是 stub**（永远返回 fallback） | `pluginContext.ts:91-95` |
| 数据源 | `data.registerDataSource` **当前是 stub**（只打日志） | `pluginContext.ts:113-116` |

### 4.2 能力缺口清单（要承载"播放器"必须补的宿主能力）

| # | 缺口 | 现状后果 | 提案 |
|---|---|---|---|
| G1 | 无自定义 UI 面板/视图承载 | 播放器界面、歌词面板、搜索框无处渲染 | `ui.registerPanel`（§6.3） |
| G2 | 无音频播放 API | 不能出声 | 宿主 `media` API + 迷你播放器（§6.3） |
| G3 | 无用户输入通道 | "搜索xxx"这类命令拿不到查询词 | `ui.prompt` / 命令 payload 约定 |
| G4 | 插件→渲染进程状态通道缺失 | 插件状态/进度/错误无法展示 | `plugin:<id>:status` 事件透传 IPC |
| G5 | 无凭据安全存储 API | 登录 cookie 只能落插件 storageDir（明文风险） | 宿主 `secrets` API（safeStorage 封装） |
| G6 | `config.get` stub | 用户配置无从生效 | 走事件总线过渡（notice-hub 先例） |

> 结论：**G1 + G2 是"播放器"形态的硬前置**；G3–G6 是体验与安全问题，可分阶段补。

---

## 5. 可行性判定与功能映射矩阵

功能逐项对照 YesPlayMusic 的功能面（§3 的功能清单）与 Trellora 插件能力（§4）：

| YesPlayMusic 功能 | Trellora 落点 | 可行性 | 阶段 | 说明 |
|---|---|---|---|---|
| 音乐搜索 | `network.fetch` 调公开搜索接口 | ✅ 数据层可行 | v0.2 | 需 G3 才有交互式搜索 |
| 排行榜/歌单浏览 | `network.fetch` + `schedule:write` 摘要 | ✅ | **v0.1** | 聚合成"今日榜单速览"日程条目 |
| 歌词展示 | `network.fetch` 拉歌词 + 解析 | ⚠️ 只能解析入库 | v0.2 | 展示需 G1；上游仅 LRC 行级，逐字歌词需自研 |
| **音频播放** | 无 API | ❌ | v0.3 | 需 G2 |
| 播放队列/音质选择 | 无 API | ❌ | v0.3 | 需 G2 |
| 登录（二维码/Cookie） | `network.fetch` + G5 | ⚠️ 风控高发 | v0.2.5 | 凭据安全存储是前置；默认改为 Cookie 导入需产品决策 |
| 歌单管理 | `schedule:write` 只能写日程 | ⚠️ 语义受限 | v0.2 | 或新增 `notes` 扩展点 |
| 桌面歌词 | Electron 专属窗口 / MPRIS+OSD | ❌ | 不移植 | 与宿主形态冲突（上游实现见 §3.4） |
| 全局快捷键/Tray | Electron 主进程能力 | ❌ | 不移植 | 属宿主自身能力，不应由插件取得 |
| 本地音乐扫描 | —（**上游亦无此功能**） | ❌ | 不移植 | 无移植对象；`files` 仅限 storageDir |
| 音乐下载 | —（**上游无独立下载模块**） | ❌ | 不移植 | 合规红线，明确不提供 |
| UnblockMusic 灰色音源 | `@unblockneteasemusic`（LGPL） | ❌ | **不移植** | 版权灰区 + LGPL 义务，合规红线 |

**判定：分层移植可行，全量移植当前不可行。** v0.1 立即可做且不改宿主；播放器形态
必须先完成宿主扩展点（§6.3）。

---

## 6. 总体架构

### 6.1 分层

```text
┌────────────────────────────────────────────────────────────┐
│ React 渲染进程（Trellora 宿主）                              │
│   侧栏插件命令按钮 ×3  ·  日程视图（展示榜单速览条目）        │
│   [Phase 3] 迷你播放器 + 面板视图（需宿主扩展）              │
└──────────────▲──────────────────────────────┬──────────────┘
        plugin:invoke-command          schedule:changed（已有）
┌──────────────┴──────────────────────────────▼──────────────┐
│ Electron 主进程 · PluginHost                                 │
│   plugins/yesplay-music/main.js（本插件）                    │
│     ├─ lib/netease.js    网易云公开 API 客户端（https only） │
│     ├─ lib/lyrics.js     LRC 解析（纯函数）                  │
│     ├─ lib/digest.js     榜单 → 摘要聚合（纯函数）           │
│     ├─ lib/cache.js      storageDir JSON 缓存               │
│     └─ lib/config.js     配置归一（事件总线接收）            │
│   扩展点：ui.registerCommand · schedule.upsertItems          │
│          network.fetch（SSRF 防护）· files（storageDir）     │
└─────────────────────────────────────────────────────────────┘
```

### 6.2 数据流（v0.1）

```text
命令触发（侧栏/命令面板）
  → netease.fetchToplist(榜单id)          [system:network, https]
  → cache 命中？→ 直接复用                 [system:file, storageDir]
  → digest.aggregate(歌曲列表)            [纯函数]
  → schedule.upsertItems('yesplay-music') [schedule:write, 幂等]
  → events.emit('plugin:yesplay-music:status')  [进程内，Phase 2 透传 UI]
  → 日程视图出现"今日榜单速览 · 新歌榜"条目
```

### 6.3 宿主扩展点提案（Phase 2/3 前置，需单独评审）

> 这些是对 Trellora 宿主（本仓库）的增量提案，不在 v0.1 插件范围内，未获批准前不实现。

**P1 · 状态透传（G4，小改动）**
`preload` 增加 `plugin.onEvent((event, payload) => …)`，把主进程事件总线的
`plugin:<id>:*` 事件镜像到渲染进程；插件管理面板可展示插件状态卡片。最小、安全、通用。

**P2 · 命令输入（G3）**
`ui.prompt({title, placeholder})` 或约定 `invokeCommand` 的 `payload` 由渲染进程提供
（如选中文本、面板输入框内容）。

**P3 · 面板承载（G1）**
`ui.registerPanel({ id, title, render: 'sandboxed-webview' | 'declarative' })`：
推荐 **声明式 UI**（插件输出 JSON 描述的列表/按钮/文本，宿主用自家组件渲染），
避免引入不受控的 webview 与插件任意 DOM 执行；YesPlayMusic 的 Vue 组件树改写为
声明式 UI 描述（成本见 §10）。

**P4 · 媒体播放（G2）**
宿主持有 `<audio>` 元素，向插件暴露受限 API：
`media.play({ url, title, artist, durationMs, lyrics? })` / `pause` / `seek` / `queue`，
播放状态与逐行歌词经 P1 通道下发给迷你播放器。**音频 URL 必须来自宿主网络守卫的校验**，
不允许插件自行取流绕过版权判断。

**P5 · 凭据保险箱（G5）**
`secrets.set/get/delete`，宿主用 Electron `safeStorage` 落盘，插件永不接触明文文件。

---

## 7. 接口契约（v0.1 冻结）

### 7.1 日程映射（`schedule.upsertItems`）

| 字段 | 取值 | 说明 |
|---|---|---|
| `source` | `'yesplay-music'` | 映射主键之一 |
| `externalId` | `digest:<榜单id>:<YYYY-MM-DD>` | 当日幂等，跨天新条目 |
| `kind` | `'event'` | 摘要性质，非待办 |
| `title` | `今日榜单速览 · <榜单名>`（≤200 截断） | |
| `description` | `1. 歌手 - 歌名（专辑）` 逐行，≤4000 截断留省略标记 | |
| `startAt`/`dueAt` | 当日 09:00（本地，无时区字符串，对齐 `shared/schedule.ts` 约定） | |
| `tags` | `['音乐', '榜单', '<榜单名>']` | |
| `category` | `'music'` | |

幂等语义遵循 `PluginScheduleUpsertItem` 契约：只碰 `(source, externalId)` 映射内的条目，
绝不触碰用户自有条目；单次 ≤500 条。

### 7.2 事件总线消息

| 事件 | 方向 | 载荷 |
|---|---|---|
| `host:yesplay-music:config` | 宿主/其他插件 → 本插件 | `{ chartIds?, maxSongs?, cacheTtlHours?, autoSync? }` |
| `host:yesplay-music:sync-now` | 宿主/其他插件 → 本插件 | 无（立即触发一次同步，串行互斥） |
| `plugin:yesplay-music:status` | 本插件 → 总线 | `{ state, lastSyncAt, lastError, cacheEntries, chartCount, nextSyncAt }`（绝不含敏感信息） |

### 7.3 配置默认值

| 键 | 默认 | 约束 |
|---|---|---|
| `chartIds` | `[19723756, 3779629, 3778678, 2884035]`（官方四榜：飙升/新歌/热歌/原创） | 网易云公开榜单 id |
| `maxSongs` | `20` | 1..100，超界收敛 |
| `cacheTtlHours` | `6` | 0.1..168 |
| `autoSync` | `false` | 每日一次；**默认关 = 安装即静默、不自动联网**，显式启用后才定时同步 |

---

## 8. 插件包设计（`plugins/yesplay-music/`）

```text
plugins/yesplay-music/
├─ plugin.json          # id com.yesplaymusic.trellora，权限见 §8.1
├─ main.js              # activate/deactivate，状态机 + 串行互斥（对齐 notice-hub）
├─ lib/
│  ├─ netease.js        # 公开 API 客户端（search/playlist/lyric/toplist）
│  ├─ lyrics.js         # LRC 解析（纯函数）
│  ├─ digest.js         # 榜单 → 摘要聚合（纯函数）
│  ├─ cache.js          # storageDir JSON 缓存（TTL）
│  └─ config.js         # 配置归一
├─ tests/               # node:test 纯逻辑单测
├─ build.mjs            # 产出 dist/yesplay-music-<version>.plugin.zip
├─ README.md            # 安装/构建/权限/隐私/限制
├─ NOTICE               # 上游署名与 clean-room 声明
├─ LICENSE-UPSTREAM     # YesPlayMusic MIT 原文
└─ LICENSE              # 本插件新增代码 MIT
```

### 8.1 权限声明（最小化）

| 权限 | 用途 | 为什么必须 |
|---|---|---|
| `ui:command` | 侧栏 3 个命令按钮 | 唯一交互入口 |
| `schedule:write` | 写入"今日榜单速览"条目 | v0.1 唯一可见输出 |
| `system:network` | 访问 music.163.com 公开接口 | 数据来源 |
| `system:file` | storageDir 内缓存与状态 | 降低接口压力、支持幂等 |

不申请 `system:subprocess`、`pipeline:parse`、`ai:provider`、`data:source`（后两者当前为 stub）。

---

## 9. 风险清单

| # | 风险 | 等级 | 缓解 |
|---|---|---|---|
| R1 | 网易云非官方接口无 SLA，随时变更/风控（频控、IP 封禁、-462/8821/8810 验证挑战，issue #2493/#2311 实证） | 高 | 只读公开接口、低频（每日 ≤2 次）、缓存、失败退避、可读错误；登录链路默认不做 |
| R2 | 接口使用需遵守网易云服务条款；不得绕过会员/付费/地域/DRM | 高（合规红线） | 仅公开数据聚合摘要；不实现付费/会员音质解锁、灰色音源、下载；v0.3 播放仅限接口正常返回的合法可播地址，上线前单独合规复核 |
| R3 | 插件无沙箱：恶意插件可绕过 context API 直接用 Node 能力 | 高（宿主安全） | 本插件自律只用 context API；建议宿主后续引入 worker/权限收紧（超出本方案范围） |
| R4 | 登录 cookie 明文存储（v0.2） | 高 | 依赖 P5 secrets API；未落地前不实现登录功能 |
| R5 | 插件 API `@experimental`，1.4.0 前可能破坏性变更 | 中 | 锁定 `engine.trellora` 区间；把 API 依赖收敛在 main.js 一层 |
| R6 | 日程承载"音乐摘要"语义牵强，用户体验存疑 | 中 | v0.1 小范围验证；开放问题 §14 由产品决策 |
| R7 | 上游 YesPlayMusic 维护状态与依赖许可（MIT 本体 + README"仅供个人学习研究"声明 + LGPL 依赖） | 中 | 见 §3.5/§11；clean-room 功能映射、三不引入、商业使用前法务评估 |
| R8 | 无输入/无输出通道，命令像"黑盒按钮" | 中 | P1/P2 落地前，命令结果都以日程条目 + 日志体现 |
| R9 | 上游 API 生态正在失效（`@neteaseapireborn/api` deprecated、Binaryify 仓库 archived） | 中 | 不绑定任何 NCM API 服务实现，只直连公开接口并把端点收敛在 `lib/netease.js` 一层，便于整体替换 |

---

## 10. 迁移成本评估

| 模块 | 工作量 | 依赖 | 备注 |
|---|---|---|---|
| v0.1 榜单摘要插件（本次交付） | ~2 人日 | 无 | 含测试、打包、合规文件 |
| 网易云 API 客户端补全（搜索/歌单/歌词/登录接口） | 2–3 人日 | R1 风控 | v0.2 |
| 凭据安全存储（P5） | 1–2 人日 | 宿主改动 | v0.2 前置 |
| 状态透传（P1）+ 命令输入（P2） | 2–3 人日 | 宿主改动 | 通用收益，建议优先 |
| 面板承载（P3）声明式 UI | 5–8 人日 | 宿主改动 | YesPlayMusic Vue UI → 声明式描述需重写 |
| 媒体播放（P4）+ 迷你播放器 | 5–8 人日 | P3 | 队列/进度/歌词滚动 |
| 歌词面板（含逐字歌词） | 3–5 人日 | P3/P4 | 上游歌词格式适配 |
| 登录（二维码/Cookie） | 3–5 人日 | P5 | 含风控应对 |
| **合计（到"可用播放器"）** | **约 22–34 人日** | 宿主 4 个扩展点 | 其中宿主侧 ≈13–19 人日 |

---

## 11. 安全、隐私与许可证合规

1. **许可证**：YesPlayMusic 以 MIT 发布（`LICENSE-UPSTREAM` 取证，Copyright 2020-2023
   qier222）；本插件新增代码用 MIT，`NOTICE` 明确"基于 qier222/YesPlayMusic 的功能设计，
   clean-room 实现，上游署名保留"。任何实际复制的上游代码片段必须逐项列入 `NOTICE`。
   上游 README 另有"仅供个人学习研究使用，禁止商业及非法用途"声明，与 MIT 并存；
   **对外分发/商业使用前需法务评估**（R7）。
2. **不绕过限制**：不实现会员音质/付费曲目解锁、灰色音源替换（UnblockMusic 一系）、
   地域限制绕过、DRM 规避、下载落盘；v0.3 播放仅限接口正常返回的合法可播地址。
3. **三不引入**：`@unblockneteasemusic/rust-napi`（LGPL-3.0-or-later + 版权灰区）；
   `@neteaseapireborn/api` / NeteaseCloudMusicApi 服务（npm deprecated、上游 archived、
   许可证未核实）；规避类请求参数（realIP 伪造、伪装官方客户端参数）——上游有，本移植不抄。
4. **隐私**：不采集任何用户数据；榜单数据只进本地缓存与日程；日志与状态载荷不含
   cookie/token；v0.2 登录态必须走宿主 `safeStorage`（P5）。
5. **密钥管理**：不硬编码任何 API key/证书/令牌；接口调用不需要密钥。
6. **权限最小化**：见 §8.1，安装时逐条可见。
7. **网络边界**：仅 https 公共域名，遵守宿主 SSRF 防护；不访问内网；不重定向到凭据 URL。

---

## 12. 构建、测试与验收标准

### 12.1 命令

```bash
node scripts/validate-plugin-manifest.mjs plugins/yesplay-music   # 清单校验
node --test plugins/yesplay-music/tests                          # 单元测试
node plugins/yesplay-music/build.mjs                             # 打包 plugin.zip
pnpm run verify:plugin-system                                    # 插件系统回归
```

### 12.2 验收清单

1. 清单校验、单测、打包三条命令全绿；zip 内只含允许文件。
2. 插件放入 `~/.trellora/plugins/` 后可在插件管理中列出、启用/禁用/卸载。
3. 触发 `sync-daily-digest` 后日程出现条目，重复触发同日幂等（不重复建条目）。
4. 断网/接口失败时产生中文可读错误，不抛裸异常，不影响宿主其他功能。
5. 日志、状态载荷、缓存文件中均无 cookie/token（grep 验证）。
6. `deactivate` 后无残留 timer/订阅。
7. 运行时验收（静态构建不能替代）：真实 macOS arm64 干净环境安装 zip 可用。

---

## 13. 实施分工（写入范围互斥）

| 范围 | 负责 | 内容 |
|---|---|---|
| `plugins/yesplay-music/**` | plugin-dev | 插件本体、测试、打包、合规文件 |
| `docs/yesplay-music-插件化移植方案.md` | lead | 本文档 |
| `plugins/README.md`（示例列表一行） | lead | 可见性 |

宿主扩展点（P1–P5）**未获批准前不写代码**。

---

## 14. 路线图与待决策问题

| 阶段 | 内容 | 前置 |
|---|---|---|
| **v0.1（本次）** | 榜单摘要插件：拉取、聚合、日程、缓存、命令 | 无 |
| v0.2 | 搜索/歌单/歌词数据层 + 状态透传(P1) + 输入(P2) | 宿主 P1/P2 |
| v0.2.5 | 登录态（二维码/Cookie）+ 凭据保险箱(P5) | 宿主 P5 |
| v0.3 | 播放器：面板(P3) + 媒体(P4) + 迷你播放器 + 歌词 | 宿主 P3/P4 |
| v0.4 | 桌面歌词等 Electron 专属能力 | 产品决策 |

**需要产品/用户决策的开放问题：**

1. 播放器 UI 承载形态：声明式面板（推荐）还是受控 webview？（影响 P3 设计）
2. "音乐"进日程的语义是否成立？若否，是否新增"音乐资料库/笔记"扩展点替代？
3. 是否接受宿主侧投入（P1–P5，≈13–19 人日）来解锁播放器形态？
4. 登录功能是否要做？（合规与风控敏感，v0.2.5 可整体砍掉）
