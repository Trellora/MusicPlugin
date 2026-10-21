/**
 * lib/config.js —— yesplay-music 插件配置：默认值、host 下发配置合并、字段校验。
 *
 * 配置经事件总线 `host:yesplay-music:config` 下发（context.config.get 目前是 stub，
 * 永远返回 fallback，不能依赖）。纯函数 + 无副作用。
 */

'use strict';

/** 官方榜单 id：单一权威来源在 lib/netease.js（OFFICIAL_CHART_IDS 映射），这里只取出 id 列表
 *  作为默认榜单配置，避免同一常量在两处重复定义而漂移。 */
const OFFICIAL_CHART_IDS = Object.freeze(Object.values(require('./netease').OFFICIAL_CHART_IDS));

/** 默认配置。 */
const DEFAULTS = Object.freeze({
  chartIds: [...OFFICIAL_CHART_IDS], // 榜单 id 列表（官方四榜）
  maxSongs: 20, // 摘要歌曲数上限，1–100，超界收敛
  cacheTtlHours: 6, // 缓存 TTL（小时），0.1–168
  autoSync: false, // 每日自动同步开关（默认关：装完先配置再启用）
});

const MAX_SONGS_MIN = 1;
const MAX_SONGS_MAX = 100;
const TTL_HOURS_MIN = 0.1;
const TTL_HOURS_MAX = 168;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toBool(value, fallback) {
  if (typeof value === 'boolean') return value;
  return fallback;
}

function clampNumber(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 整数型数值收敛：先四舍五入再钳制到 [min, max]（用于 maxSongs 这类必须为整数的配置）。 */
function clampInt(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 归一化榜单 id 列表：正整数数组，去重，上限 20 个。非法整体返回 null。 */
function normalizeChartIds(value) {
  if (!Array.isArray(value)) return null;
  const ids = [];
  for (const item of value) {
    const n = typeof item === 'number' ? Math.round(item) : Number.parseInt(String(item ?? ''), 10);
    if (Number.isFinite(n) && n > 0 && !ids.includes(n)) ids.push(n);
  }
  if (ids.length === 0) return null;
  return ids.slice(0, 20);
}

/**
 * 校验并归一化一份配置。
 * @param {unknown} raw 任意来源（默认值 + host:yesplay-music:config 的部分覆盖）
 * @param {object} [base] 基准配置（默认取 DEFAULTS）
 * @returns {{ config: typeof DEFAULTS, warnings: string[] }} 无效字段回退基准值并给出中文警告
 */
function normalizeConfig(raw, base = DEFAULTS) {
  const warnings = [];
  const input = isPlainObject(raw) ? raw : {};
  const config = { ...DEFAULTS, ...base };

  if ('chartIds' in input) {
    const ids = normalizeChartIds(input.chartIds);
    if (ids) config.chartIds = ids;
    else warnings.push(`榜单 id 列表无效（${JSON.stringify(input.chartIds)}），已保留原值。需为正整数数组。`);
  }

  if ('maxSongs' in input) {
    const rawValue = input.maxSongs;
    const n = typeof rawValue === 'number' ? Math.round(rawValue) : Number.parseInt(String(rawValue ?? ''), 10);
    if (!Number.isFinite(n)) warnings.push(`摘要歌曲数无效（${String(rawValue)}），已使用默认值 ${config.maxSongs}。`);
    else if (n < MAX_SONGS_MIN || n > MAX_SONGS_MAX) {
      warnings.push(`摘要歌曲数 ${n} 超出 ${MAX_SONGS_MIN}–${MAX_SONGS_MAX} 范围，已收敛到边界值。`);
    }
    // 先取整再钳制，保证结果恒为 1–100 的整数（README:46「收敛到 1–100」隐含整数语义）。
    config.maxSongs = clampInt(rawValue, MAX_SONGS_MIN, MAX_SONGS_MAX, config.maxSongs);
  }

  if ('cacheTtlHours' in input) {
    const rawValue = input.cacheTtlHours;
    const n = typeof rawValue === 'number' ? rawValue : Number.parseFloat(String(rawValue ?? ''));
    if (!Number.isFinite(n)) warnings.push(`缓存 TTL 无效（${String(rawValue)}），已使用默认值 ${config.cacheTtlHours} 小时。`);
    else if (n < TTL_HOURS_MIN || n > TTL_HOURS_MAX) {
      warnings.push(`缓存 TTL ${n} 小时超出 ${TTL_HOURS_MIN}–${TTL_HOURS_MAX} 范围，已收敛到边界值。`);
    }
    config.cacheTtlHours = clampNumber(rawValue, TTL_HOURS_MIN, TTL_HOURS_MAX, config.cacheTtlHours);
  }

  if ('autoSync' in input) config.autoSync = toBool(input.autoSync, config.autoSync);

  return { config, warnings };
}

/**
 * 供日志/状态输出的配置摘要（无敏感字段；本插件不持有任何凭据）。
 * @param {typeof DEFAULTS} config
 */
function configSummary(config) {
  return {
    chartIds: [...config.chartIds],
    maxSongs: config.maxSongs,
    cacheTtlHours: config.cacheTtlHours,
    autoSync: config.autoSync,
  };
}

module.exports = {
  DEFAULTS,
  OFFICIAL_CHART_IDS,
  MAX_SONGS_MIN,
  MAX_SONGS_MAX,
  TTL_HOURS_MIN,
  TTL_HOURS_MAX,
  clampNumber,
  clampInt,
  normalizeChartIds,
  normalizeConfig,
  configSummary,
};
