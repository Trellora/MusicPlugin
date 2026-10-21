# YesPlayMusic for Trellora · 音乐伴侣（com.yesplaymusic.trellora）

[YesPlayMusic](https://github.com/qier222/YesPlayMusic) 的**功能映射与 clean-room 移植尝试**：
把网易云音乐官方榜单聚合成「今日榜单速览」，写入 Trellora 日程，在日/周/月/年视图与提醒体系里
看到每天的榜单动向。

- 功能设计参考 YesPlayMusic（MIT，署名保留，见 [NOTICE](NOTICE) 与 [LICENSE-UPSTREAM](LICENSE-UPSTREAM)）；截至 v0.1 未复制上游任何源码。
- 设计契约：[`docs/yesplay-music-插件化移植方案.md`](docs/yesplay-music-插件化移植方案.md)。
- 数据流向：music.163.com 公开接口 → 插件 → 本地缓存（storageDir）+ Trellora 日程库。**数据仅存本机，不外传。**

## 1. 这是什么 / v0.1 能做什么

### 能做（v0.1）

- **今日榜单速览**：拉取官方榜单（飙升榜 19723756、新歌榜 3779629、热歌榜 3778678、原创榜
  2884035，可配置）→ 聚合成摘要 → 写入日程条目「今日榜单速览 · 新歌榜」，描述里逐行列出
  「序号. 歌手 - 歌名（专辑）」。
- **幂等同步**：同一天同一榜单的条目固定 `digest:<榜单id>:<YYYY-MM-DD>`，重复同步只更新不重复建。
- **本地缓存**：榜单响应按「接口名 + 参数哈希」缓存（TTL 可配，默认 6 小时），减少对上游接口的请求。
- **搜索 / 歌词解析能力**（`lib/netease.js` / `lib/lyrics.js`，随包发布，供后续版本与测试使用）：
  歌曲搜索、LRC 歌词解析（时间戳、多标签、offset、元信息过滤）。
- **状态可观测**：命令 `yesplay-music:status` 把缓存条数、上次同步时间、上次错误发到
  `plugin:yesplay-music:status` 事件。

### 不能做（v0.1，明确排除）

- **不含播放器界面与音频播放**——原因见 [`docs/yesplay-music-插件化移植方案.md`](docs/yesplay-music-插件化移植方案.md)：
  插件 API 只有「命令按钮」这一种 UI 渲染形式（无输入界面、无输出展示界面），且音频播放涉及
  版权与平台音频通道能力，均超出 v0.1 的 API 边界与合规范围。
- **不含登录态能力**：每日推荐、我的歌单接口只留函数签名，调用会返回「v0.2 需要登录态」的可读错误；
  **不注入 cookie、不做登录**。
- **不绕过付费 / DRM / 地域限制**：只读公开接口，不实现任何绕过逻辑。
- 歌曲详情页、评论、MV、歌单收藏等 YesPlayMusic 的其他交互，v0.1 均未实现。

## 2. 安装

### 2.1 从 zip 安装

1. 获取插件包 `yesplay-music-<version>.plugin.zip`（内含 `plugin.json`、`main.js`、`lib/`、
   `README.md`、`NOTICE`、`LICENSE`、`LICENSE-UPSTREAM`）。
2. Trellora 设置 → 插件 → **安装** → 拖入 zip（或输入发布 URL）。
3. 阅读权限声明并确认（逐条解释见 §4）。
4. 安装后按 `onStartup` 自动激活；默认 `autoSync=false`，先配置再启用（见 §3）。

### 2.2 本地开发安装

把整个 `plugins/yesplay-music/` 目录拷贝到 `~/.trellora/plugins/com.yesplaymusic.trellora/`，
重启 Trellora（或在插件管理中刷新）。

## 3. 配置

配置经宿主设置面板下发（事件 `host:yesplay-music:config`；`context.config.get` 目前是 stub，
插件不依赖它）。插件侧做字段校验，非法值回退默认并给出中文警告：

| 配置项 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `chartIds` | number[] | `[19723756, 3779629, 3778678, 2884035]` | 榜单 id 列表（官方四榜），正整数、去重、≤20 个 |
| `maxSongs` | number | `20` | 摘要列入的歌曲数上限，收敛到 1–100 |
| `cacheTtlHours` | number | `6` | 榜单响应缓存 TTL（小时），收敛到 0.1–168 |
| `autoSync` | boolean | `false` | 每日自动同步开关；关闭时定时器停止、状态为「已禁用」 |

## 4. 权限清单（逐条解释）

| 权限 | 层级 | 为什么需要 |
|---|---|---|
| `ui:command` | L1 | 注册 3 个侧栏命令按钮（同步速览 / 清缓存 / 看状态）。命令只渲染成按钮，`execute` 在主进程跑 |
| `schedule:write` | L1 | 把「今日榜单速览」写入日程。只写 `source='yesplay-music'` 自己映射的条目，幂等 upsert，绝不触碰用户手工创建的日程 |
| `system:network` | L2 | 访问 `music.163.com` 公开接口（榜单/歌单详情、搜索、歌词）。只走宿主 `context.network.fetch`：仅 https、公共域名、SSRF 防护、10 秒超时 |
| `system:file` | L2 | 读写插件自己的 storageDir 缓存（`yesplay-music-cache.json`）。只走 `context.files`，防路径穿越，无法读插件目录之外的任何文件 |

插件**不申请** `system:subprocess`，不启动任何子进程；不使用 `data:source`（当前是 stub）。

## 5. 隐私说明

- **不收集用户数据**：无账号、无 cookie、无 token、无埋点；插件不持有任何凭据。
- 榜单数据只进**本地缓存**（插件 storageDir）与**本地日程库**，不上传、不外传。
- 发往网易云的请求仅含公开接口参数（榜单 id、搜索词、歌曲 id）与必要的 Referer/UA 请求头。
- 日志、状态载荷（`plugin:yesplay-music:status`）只含同步状态与计数，不含敏感信息。

## 6. 命令

| 命令 id | 作用 |
|---|---|
| `yesplay-music:sync-daily-digest` | 立即拉榜单 → 聚合摘要 → 写入日程（幂等） |
| `yesplay-music:clear-cache` | 清空榜单缓存 |
| `yesplay-music:status` | 发布插件状态到事件总线 |

## 7. 构建与测试

```bash
# 1. manifest 校验（打包前 build.mjs 会自动先跑这一步）
node scripts/validate-plugin-manifest.mjs plugins/yesplay-music

# 2. 纯逻辑单测（lyrics 解析 / digest 聚合与截断 / cache 键与 TTL / config 归一化）
node --test plugins/yesplay-music/tests

# 3. 打包（产出 dist/yesplay-music-<version>.plugin.zip）
node plugins/yesplay-music/build.mjs

# 4. 核对 zip 清单
unzip -l dist/yesplay-music-0.1.0.plugin.zip

# 5. 入口可加载性自检
node -e "const p=require('./plugins/yesplay-music/main.js'); console.log(typeof p.activate)"
```

## 8. 更新日志

### 0.1.0（首个版本）

- 今日榜单速览：官方四榜（可配置）→ 摘要聚合 → 日程幂等写入。
- `lib/netease.js`：网易云公开接口 https 客户端（榜单/搜索/歌词；登录态接口留签名并返回
  「v0.2 需要登录态」错误）。
- `lib/lyrics.js`：LRC 解析（多标签、offset、元信息过滤、排序）。
- `lib/digest.js`：榜单摘要聚合（标题 ≤200、描述 ≤4000、超长截断留省略标记）。
- `lib/cache.js`：基于 `context.files` 的 TTL JSON 缓存（接口名 + 参数哈希键）。
- 3 个侧栏命令 + `plugin:yesplay-music:status` 状态事件。
- 明确不包含：播放器界面、音频播放、登录态能力（见 §1）。

## 9. 许可

- 本插件新增代码：MIT，见 [LICENSE](LICENSE)（Copyright (c) 2026 Trellora contributors）。
- YesPlayMusic 上游：MIT，见 [LICENSE-UPSTREAM](LICENSE-UPSTREAM)（Copyright (c) 2020-2023 qier222）；
  移植关系与合规说明见 [NOTICE](NOTICE)。
