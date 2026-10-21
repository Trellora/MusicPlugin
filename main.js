// Trellora 插件：com.yesplaymusic.trellora（YesPlayMusic for Trellora · 音乐伴侣）
//
// 把网易云音乐官方榜单聚合成「今日榜单速览」并同步进 Trellora 日程。
// 功能设计参考 https://github.com/qier222/YesPlayMusic（clean-room 移植尝试，见 NOTICE）。
// 设计契约：docs/yesplay-music-插件化移植方案.md（v0.1 不含播放器界面与音频播放，原因见该文档）。
//
// 入口约定：导出 { activate, deactivate }（CommonJS）。
//
// 安全：只经 context.* API 访问网络/文件/日程；不引入 node:fs / node:http / node:child_process；
// 日志、缓存、状态载荷不含任何凭据（本插件不持有凭据）；不实现付费/DRM/地域限制绕过。

'use strict';

const { DEFAULTS, normalizeConfig, configSummary } = require('./lib/config');
const { createClient, CHART_NAMES } = require('./lib/netease');
const { buildDigest } = require('./lib/digest');
const cacheLib = require('./lib/cache');

const SOURCE = 'yesplay-music'; // schedule 映射表的 source 主键
const EVENT_CONFIG = 'host:yesplay-music:config';
const EVENT_SYNC_NOW = 'host:yesplay-music:sync-now';
const EVENT_STATUS = 'plugin:yesplay-music:status';
const UPSERT_BATCH_LIMIT = 500; // 契约：schedule.upsertItems 单次上限 500 条
const DAY_MS = 24 * 60 * 60 * 1000; // 每日自动同步间隔

// ── 模块状态 ────────────────────────────────────────────────────────────────

let ctx = null;
let cache = null;
let config = { ...DEFAULTS };
let timer = null;
let syncing = false;
let pendingTrigger = null; // 串行互斥：同步中再触发则合并排队（只排一次）
const unsubscribers = [];

const status = {
  state: 'disabled',
  lastSyncAt: null,
  lastSuccessAt: null,
  lastError: null,
  cacheEntries: 0,
  chartCount: 0,
  nextSyncAt: null,
};

function nowIso() {
  return new Date().toISOString();
}

/** 本地日期 YYYY-MM-DD（用于 externalId 与全天条目归属）。 */
function localDateStr(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 发布状态到事件总线（plugin:yesplay-music:status）。载荷不含敏感信息。 */
function publishStatus(patch = {}) {
  Object.assign(status, patch);
  const payload = {
    state: status.state,
    lastSyncAt: status.lastSyncAt,
    lastSuccessAt: status.lastSuccessAt,
    lastError: status.lastError,
    cacheEntries: status.cacheEntries,
    chartCount: status.chartCount,
    nextSyncAt: status.nextSyncAt,
  };
  if (ctx && ctx.events) ctx.events.emit(EVENT_STATUS, payload);
  return payload;
}

function logInfo(message) {
  if (ctx && ctx.log) ctx.log.info(message);
}
function logWarn(message) {
  if (ctx && ctx.log) ctx.log.warn(message);
}
function logError(message) {
  if (ctx && ctx.log) ctx.log.error(message);
}

// ── 定时器（deactivate 必须清理） ───────────────────────────────────────────

function clearTimer() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

function restartTimer() {
  clearTimer();
  if (!config.autoSync) {
    status.nextSyncAt = null;
    return;
  }
  timer = setInterval(() => {
    requestSync('timer');
  }, DAY_MS);
  // 等价 unref 语义：定时器不阻止宿主退出。
  if (timer && typeof timer.unref === 'function') timer.unref();
  status.nextSyncAt = new Date(Date.now() + DAY_MS).toISOString();
}

// ── 配置合并（默认值 + host:yesplay-music:config） ───────────────────────────

function applyConfig(raw) {
  const { config: merged, warnings } = normalizeConfig(raw, config);
  config = merged;
  for (const warning of warnings) logWarn(`[配置] ${warning}`);
  logInfo(`配置已更新：${JSON.stringify(configSummary(config))}`);
  restartTimer();
  if (config.autoSync) {
    if (status.state === 'disabled' || status.state === 'error') {
      publishStatus({ state: 'idle', nextSyncAt: status.nextSyncAt });
    }
    requestSync('config');
  } else {
    publishStatus({ state: 'disabled', nextSyncAt: null });
  }
}

// ── 同步编排（串行互斥 + 合并排队） ─────────────────────────────────────────

function requestSync(trigger) {
  if (syncing) {
    pendingTrigger = trigger; // 合并排队：只保留一次排队执行
    return Promise.resolve();
  }
  return runSync(trigger);
}

async function upsertBatched(items) {
  for (let i = 0; i < items.length; i += UPSERT_BATCH_LIMIT) {
    await ctx.schedule.upsertItems(SOURCE, items.slice(i, i + UPSERT_BATCH_LIMIT));
  }
}

/** 刷新状态里的缓存条数（失败静默）。 */
async function refreshCacheCount() {
  if (!cache) return;
  try {
    const stats = await cache.stats();
    status.cacheEntries = stats.total;
  } catch {
    // 静默：统计失败不影响主流程
  }
}

/**
 * 执行一次同步：榜单 →（缓存/网络）→ 摘要 → 日程幂等 upsert。
 * 降级语义：单个榜单失败不阻断其余榜单；全部失败才进 error 状态、不写库。
 * 同一天同一榜单的 externalId 不变（`digest:<榜单id>:<YYYY-MM-DD>`），upsert 幂等更新。
 */
async function runSync(trigger) {
  syncing = true;
  publishStatus({ state: 'syncing', lastSyncAt: nowIso() });
  logInfo(`开始同步榜单速览（触发：${trigger}）`);

  const warnings = [];
  const items = [];
  const today = localDateStr();
  const dayStartIso = (() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  })();
  const ttlMs = Math.round(config.cacheTtlHours * 60 * 60 * 1000);

  try {
    const client = createClient({
      fetchImpl: (url, init) => ctx.network.fetch(url, init),
    });

    for (const chartId of config.chartIds) {
      const chartName = CHART_NAMES[chartId] || `榜单 ${chartId}`;
      const cacheKey = cacheLib.makeKey('playlist-detail', { id: chartId, n: 500 });

      // 1) 缓存优先，未命中才走网络，成功后回写缓存。
      let playlist = null;
      try {
        playlist = await cache.get(cacheKey);
      } catch {
        playlist = null;
      }
      if (!playlist) {
        const res = await client.fetchPlaylistDetail(chartId);
        if (!res.ok) {
          warnings.push(`${chartName}：${res.message}`);
          continue;
        }
        playlist = res.data;
        try {
          await cache.set(cacheKey, playlist, ttlMs);
        } catch (error) {
          logWarn(`写入缓存失败（${chartName}）：${error && error.message ? error.message : error}`);
        }
      }

      // 2) 聚合摘要（纯函数）。
      const digest = buildDigest(playlist.tracks, { chartName, limit: config.maxSongs });
      items.push({
        externalId: `digest:${chartId}:${today}`,
        kind: 'event',
        title: digest.title,
        description: digest.description,
        allDay: true,
        startAt: dayStartIso,
        category: '音乐',
        tags: ['yesplay-music', chartName],
      });
    }

    if (items.length === 0) {
      const message = warnings.length > 0
        ? `全部榜单拉取失败：${warnings.slice(0, 3).join('；')}`
        : '未配置任何榜单 id，无法生成速览。';
      throw Object.assign(new Error(message), { code: 'no-data' });
    }

    await upsertBatched(items);
    await refreshCacheCount();

    const warningText = warnings.length > 0 ? warnings.slice(0, 3).join('；') : null;
    publishStatus({
      state: 'ok',
      lastSuccessAt: nowIso(),
      lastError: warningText,
      chartCount: items.length,
      nextSyncAt: status.nextSyncAt,
    });
    logInfo(`同步完成：榜单速览 ${items.length} 条${warningText ? `，警告：${warningText}` : ''}`);
    if (warningText) logWarn(`同步完成但有警告：${warningText}`);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    // 降级：不写库、不删已有条目；错误文案面向用户且可读。
    publishStatus({ state: 'error', lastError: message });
    logError(`同步失败：${message}`);
  } finally {
    syncing = false;
    if (pendingTrigger) {
      const next = pendingTrigger;
      pendingTrigger = null;
      setImmediate(() => {
        requestSync(next);
      });
    }
  }
}

// ── 入口 ────────────────────────────────────────────────────────────────────

module.exports = {
  activate(context) {
    ctx = context;
    config = { ...DEFAULTS };
    cache = cacheLib.createCache(context.files);

    logInfo(`activating ${context.manifest.id}（默认配置已载入，等待 host:yesplay-music:config）`);

    // 注册 UI 命令（panel: 'sidebar'，与 plugin.json contributes.uiCommands 一一对应）。
    context.ui.registerCommand({
      id: 'yesplay-music:sync-daily-digest',
      title: '同步今日榜单速览',
      panel: 'sidebar',
      execute: () => {
        // 失败不抛异常，状态进 plugin:yesplay-music:status。
        requestSync('manual');
      },
    });

    context.ui.registerCommand({
      id: 'yesplay-music:clear-cache',
      title: '清空榜单缓存',
      panel: 'sidebar',
      execute: async () => {
        try {
          await cache.clear();
          logInfo('榜单缓存已清空。');
        } catch (error) {
          logWarn(`清空缓存失败：${error && error.message ? error.message : error}`);
        }
        await refreshCacheCount();
        publishStatus({ cacheEntries: status.cacheEntries });
      },
    });

    context.ui.registerCommand({
      id: 'yesplay-music:status',
      title: '查看插件状态',
      panel: 'sidebar',
      execute: async () => {
        await refreshCacheCount();
        publishStatus();
      },
    });

    // 事件订阅（配置经事件总线下发；context.config.get 是 stub，不可依赖）。
    unsubscribers.push(context.events.on(EVENT_CONFIG, (payload) => {
      applyConfig(payload);
    }));
    unsubscribers.push(context.events.on(EVENT_SYNC_NOW, () => {
      requestSync('manual');
    }));

    // 每日自动同步定时器（当前为默认配置，config 事件到达后重启）。
    restartTimer();
    refreshCacheCount().then(() => {
      publishStatus({ state: config.autoSync ? 'idle' : 'disabled', nextSyncAt: status.nextSyncAt });
    });
  },

  deactivate() {
    clearTimer();
    while (unsubscribers.length > 0) {
      const off = unsubscribers.pop();
      try {
        if (typeof off === 'function') off();
      } catch {
        // 忽略退订异常
      }
    }
    pendingTrigger = null;
    cache = null;
    ctx = null;
  },
};
