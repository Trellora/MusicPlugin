/**
 * lib/lyrics.js —— LRC 歌词解析（纯函数，无 IO、无副作用）。
 *
 * 规则：
 *   - 时间标签 [mm:ss.xx] / [mm:ss.xxx] / [mm:ss]，一行可有多个标签（展开为多条）；
 *   - 元信息行（[ti:] [ar:] [al:] [by:] [offset:] 等）忽略，但 [offset:] 会全局应用；
 *   - offset 单位毫秒，正负均可：timeMs = 标签时间 + offset（按 LRC 惯例取反向应用由调用方决定，
 *     本实现直接把 offset 加到每行时间上，与常见播放器「offset 正值歌词提前」保持一致的相反约定
 *     会在注释中说明——为可预期起见，v0.1 采用「原始时间 + offset」的直接语义）；
 *   - 输出按 timeMs 升序（同刻保持原文顺序），过滤空文本行；
 *   - 任何输入异常都返回 []，不抛裸异常。
 */

'use strict';

// 时间标签：[mm:ss]、[mm:ss.xx]、[mm:ss.xxx]、[mm:ss.xxxx]（分钟 1~3 位，小数秒 1~4 位）
const TIME_TAG_RE = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,4}))?\]/g;
// 元信息标签：[ti:xxx] / [ar:xxx] / [al:xxx] / [by:xxx] / [offset:xxx] 等（冒号后非数字时间）
const META_TAG_RE = /^\[(ti|ar|al|by|offset|re|ve|length|tool)\s*:/i;

/** 把小数秒片段归一为毫秒。frac 是小数点后的数字串，语义为「秒的定点小数」：
 *  '5' → 500ms（0.5 秒），'50' → 500ms（0.50 秒），'500' → 500ms（0.500 秒），
 *  '1234' → 123ms（0.1234 秒 ≈ 123.4ms，四舍五入），'9995' → 1000ms（0.9995 秒 ≈ 999.5ms，进位）。
 *  超出毫秒的精度按四舍五入（而非截断）归一；返回值可能达到 1000（进位），
 *  由 tagToMs 加到 ss*1000 时自然进位到分钟，无需 clamp。 */
function fracToMs(frac) {
  if (!frac) return 0;
  // frac 是小数点后的数字串，位数 = 10^(-len) 秒；换算到毫秒 = frac * 10^(3-len)。
  const len = frac.length;
  const scale = 3 - len; // 正数=放大（'5'→500），0=不变（'500'），负数=缩小（'1234'→123.4）
  const raw = Number.parseInt(frac, 10) || 0;
  if (scale >= 0) return raw * Math.pow(10, scale);
  // 精度超出毫秒：四舍五入（用字符串避免浮点误差）
  const divisor = Math.pow(10, -scale);
  return Math.round(raw / divisor);
}

/** 解析单个时间标签的毫秒值；非法返回 null。 */
function tagToMs(mm, ss, frac) {
  const minutes = Number.parseInt(mm, 10);
  const seconds = Number.parseInt(ss, 10);
  if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) return null;
  if (seconds > 59) return null; // 非法时间戳（秒必须 0–59）
  return minutes * 60 * 1000 + seconds * 1000 + fracToMs(frac);
}

/** 从整篇 LRC 文本里提取 offset（毫秒）；缺失或非法返回 0。 */
function extractOffsetMs(text) {
  const match = /\[offset\s*:\s*([+-]?\d+)\s*\]/i.exec(text);
  if (!match) return 0;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) ? value : 0;
}

/**
 * 解析 LRC 歌词。
 * @param {unknown} lrcText LRC 全文（可为 null / 非字符串 → []）
 * @returns {Array<{ timeMs: number, text: string }>} 已排序、已应用 offset、已过滤空行
 */
function parseLrc(lrcText) {
  if (typeof lrcText !== 'string' || lrcText.trim() === '') return [];

  const offsetMs = extractOffsetMs(lrcText);
  const lines = lrcText.split(/\r\n|\r|\n/);
  /** @type {Array<{ timeMs: number, text: string, order: number }>} */
  const entries = [];
  let order = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '') continue;
    if (META_TAG_RE.test(line)) continue; // 元信息行整体忽略

    // 收集本行所有时间标签
    TIME_TAG_RE.lastIndex = 0;
    const times = [];
    let match;
    while ((match = TIME_TAG_RE.exec(line)) !== null) {
      const ms = tagToMs(match[1], match[2], match[3]);
      if (ms !== null) times.push(ms);
    }
    if (times.length === 0) continue; // 无时间标签的普通文本行忽略

    // 文本 = 去掉全部时间标签后的剩余部分
    const text = line.replace(TIME_TAG_RE, '').trim();
    if (text === '') continue; // 过滤空文本行（纯标签行）

    for (const timeMs of times) {
      entries.push({ timeMs: timeMs + offsetMs, text, order: order++ });
    }
  }

  // 稳定排序：先 timeMs 升序，同刻按出现顺序
  entries.sort((a, b) => (a.timeMs - b.timeMs) || (a.order - b.order));
  return entries.map(({ timeMs, text }) => ({ timeMs, text }));
}

module.exports = { parseLrc, extractOffsetMs, tagToMs, fracToMs };
