/**
 * lib/cache.js —— 基于 context.files 的 JSON 缓存（key → { savedAt, ttlMs, data }）。
 *
 * 约定：
 *   - 读写**只经 context.files**（权限 system:file，路径限定插件 storageDir），不碰 node:fs；
 *   - 缓存键 = 接口名 + 参数哈希（makeKey，参数稳定序列化后取 FNV-1a）；
 *   - TTL 过期判定纯函数化（isExpired），便于单测；
 *   - 缓存文件为单个 JSON：{ version, entries: { [key]: { savedAt, ttlMs, data } } }。
 */

'use strict';

const CACHE_FILE = 'yesplay-music-cache.json';
const CACHE_VERSION = 1;

// ── 纯函数：稳定序列化 / 参数哈希 / 键 / TTL 判定 ─────────────────────────────

/** 稳定 JSON 序列化：对象键递归排序，保证同一参数对象总得到同一字符串。
 *  循环引用抛出可读 TypeError（不静默产出错误字符串）；undefined/NaN/null 严格区分，
 *  避免不同参数被误判为同一键。 */
function stableStringify(value, seen = new WeakSet()) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'number') return Number.isFinite(value) ? String(value) : `number:${String(value)}`;
  if (t === 'boolean') return String(value);
  if (t === 'string') return JSON.stringify(value);
  if (t === 'function') return `function:${value.name || 'anonymous'}`;
  if (t === 'symbol') return `symbol:${value.toString()}`;
  if (t === 'bigint') return `bigint:${value.toString()}`;
  // object / array
  if (seen.has(value)) throw new TypeError('stableStringify: 检测到循环引用，无法生成稳定键。');
  seen.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item, seen)).join(',')}]`;
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k], seen)}`).join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

/** FNV-1a 32 位哈希（hex），只用内置运算，无第三方依赖。
 *  按 UTF-8 字节哈希（而非 charCode），保证 emoji/非 BMP 字符与任何 Unicode 输入
 *  在不同 JS 引擎/平台下得到同一键，避免缓存键碰撞（缓存投毒）。 */
function fnv1aHex(text) {
  const bytes = new TextEncoder().encode(String(text ?? ''));
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * 生成缓存键：接口名 + 参数哈希。
 * @param {string} api 接口名（如 'playlist-detail'）
 * @param {object} [params] 参数对象（如 { id: 19723756 }）
 */
function makeKey(api, params = {}) {
  return `${String(api)}:${fnv1aHex(stableStringify(params ?? {}))}`;
}

/**
 * TTL 过期判定（纯函数）。
 * @param {{ savedAt?: string, ttlMs?: number } | null | undefined} entry 缓存条目
 * @param {number} [nowMs] 当前时间戳（毫秒），默认 Date.now()
 * @returns {boolean} 条目缺失/字段非法/已过期 → true
 */
function isExpired(entry, nowMs = Date.now()) {
  if (!entry || typeof entry !== 'object') return true;
  const savedAtMs = Date.parse(String(entry.savedAt ?? ''));
  const ttlMs = Number(entry.ttlMs);
  if (!Number.isFinite(savedAtMs) || !Number.isFinite(ttlMs) || ttlMs < 0) return true;
  return nowMs - savedAtMs > ttlMs;
}

// ── 基于 context.files 的读写封装 ────────────────────────────────────────────

function encode(doc) {
  return new TextEncoder().encode(JSON.stringify(doc, null, 2));
}

function decode(bytes) {
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** 读缓存文档；缺失/损坏/版本不符 → 空文档（不抛错）。 */
async function loadDoc(files) {
  try {
    const bytes = await files.readFile(CACHE_FILE);
    const doc = decode(bytes);
    if (!doc || typeof doc !== 'object' || doc.version !== CACHE_VERSION || typeof doc.entries !== 'object') {
      return { version: CACHE_VERSION, entries: {} };
    }
    return doc;
  } catch {
    return { version: CACHE_VERSION, entries: {} };
  }
}

/**
 * 创建缓存实例。
 * @param {{ readFile: Function, writeFile: Function }} files context.files
 */
function createCache(files) {
  // 串行化所有读写：loadDoc→mutate→writeFile 必须原子，否则并发 get/set 会互相覆盖丢数据。
  // 用一条 promise 链（chain）保证任意时刻只有一个操作在读写缓存文档。
  let chain = Promise.resolve();
  const serialize = (fn) => {
    const next = chain.then(fn, fn);
    // 链路自身不因某个操作失败而断裂（错误由调用方通过返回值/rejection 处理）。
    chain = next.then(() => undefined, () => undefined);
    return next;
  };

  return {
    /** 未过期返回 data，否则 null（过期条目顺手从文档剔除并回写，失败静默）。 */
    get(key, nowMs = Date.now()) {
      return serialize(async () => {
        const doc = await loadDoc(files);
        const entry = doc.entries[key];
        if (isExpired(entry, nowMs)) {
          if (entry) {
            delete doc.entries[key];
            try { await files.writeFile(CACHE_FILE, encode(doc)); } catch { /* 静默 */ }
          }
          return null;
        }
        return entry.data;
      });
    },

    /** 写入一条缓存（覆盖同键旧条目）。ttlMs 必须是有限非负数，否则抛可读错误（不静默产生永久失效条目）。 */
    set(key, data, ttlMs, nowMs = Date.now()) {
      const normalizedTtl = Number(ttlMs);
      if (!Number.isFinite(normalizedTtl) || normalizedTtl < 0) {
        return Promise.reject(new TypeError(`cache.set: ttlMs 必须是有限非负数，收到 ${String(ttlMs)}`));
      }
      return serialize(async () => {
        const doc = await loadDoc(files);
        // set 时顺手清理过期条目，避免长生命周期进程只写不读导致条目无界增长。
        for (const existingKey of Object.keys(doc.entries)) {
          if (isExpired(doc.entries[existingKey], nowMs)) delete doc.entries[existingKey];
        }
        doc.entries[key] = { savedAt: new Date(nowMs).toISOString(), ttlMs: normalizedTtl, data };
        await files.writeFile(CACHE_FILE, encode(doc));
        return doc.entries[key];
      });
    },

    /** 清空全部缓存（files API 无删除接口，写入空文档即视为清空）。 */
    clear() {
      return serialize(async () => {
        const doc = { version: CACHE_VERSION, entries: {} };
        await files.writeFile(CACHE_FILE, encode(doc));
        return { cleared: true };
      });
    },

    /** 缓存统计：条目数、新鲜/过期条数、最旧写入时间（不含任何敏感信息）。 */
    stats(nowMs = Date.now()) {
      return serialize(async () => {
        const doc = await loadDoc(files);
        const keys = Object.keys(doc.entries);
        let fresh = 0;
        let stale = 0;
        let oldest = null;
        for (const key of keys) {
          const entry = doc.entries[key];
          if (isExpired(entry, nowMs)) stale += 1;
          else fresh += 1;
          if (entry && typeof entry.savedAt === 'string' && (oldest === null || entry.savedAt < oldest)) {
            oldest = entry.savedAt;
          }
        }
        return { total: keys.length, fresh, stale, oldestSavedAt: oldest };
      });
    },
  };
}

module.exports = {
  CACHE_FILE,
  CACHE_VERSION,
  stableStringify,
  fnv1aHex,
  makeKey,
  isExpired,
  createCache,
};
