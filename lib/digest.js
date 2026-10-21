/**
 * lib/digest.js —— 榜单歌曲列表 → 「今日榜单速览」摘要（纯函数，无 IO、无副作用）。
 *
 * 契约：
 *   - 输入 [{ name, artists, album, durationMs }]（字段缺失时优雅降级，不抛异常）；
 *   - 输出 { title, description }：
 *     · title ≤ 200 字符，形如「今日榜单速览 · 新歌榜」；
 *     · description ≤ 4000 字符，逐行「序号. 歌手 - 歌名（专辑）」，超长截断并留省略标记。
 */

'use strict';

const TITLE_MAX = 200;
const DESCRIPTION_MAX = 4000;
const ELLIPSIS = '…';
const SONG_NAME_MAX = 120;      // 单首歌名截断上限
const LINE_MAX = 220;           // 单行「序号. 歌手 - 歌名（专辑）」截断上限
const TRUNCATION_RESERVE = 32;  // 整体超长截断时给尾部省略标记（含省略首数）预留的字符数

/** 字符级截断：超长时在 limit 内保留省略标记。limit ≤ 0 返回空串（不产生超限字符）。 */
function truncate(text, limit) {
  const str = String(text ?? '');
  if (limit <= 0) return '';
  if (str.length <= limit) return str;
  return str.slice(0, limit - 1) + ELLIPSIS;
}

/** 把 artists 归一为「歌手」字符串：支持 string / string[] / {name}[] 混合输入。 */
function formatArtists(artists) {
  if (typeof artists === 'string') return artists.trim() || '未知歌手';
  if (Array.isArray(artists)) {
    const names = artists
      .map((a) => {
        if (typeof a === 'string') return a.trim();
        if (a && typeof a === 'object' && typeof a.name === 'string') return a.name.trim();
        return '';
      })
      .filter(Boolean);
    return names.length > 0 ? names.join('/') : '未知歌手';
  }
  return '未知歌手';
}

/** 把 album 归一为字符串（string 或 {name}）。 */
function formatAlbum(album) {
  if (typeof album === 'string') return album.trim();
  if (album && typeof album === 'object' && typeof album.name === 'string') return album.name.trim();
  return '';
}

/**
 * 聚合「今日榜单速览」摘要。
 * @param {unknown} songs 歌曲数组 [{ name, artists, album, durationMs }]
 * @param {object} [options]
 * @param {string} [options.chartName] 榜单名（如「新歌榜」），出现在标题里
 * @param {number} [options.limit] 列入摘要的歌曲数上限（默认 20，≥1）
 * @returns {{ title: string, description: string, count: number }}
 */
function buildDigest(songs, options = {}) {
  const chartName = typeof options.chartName === 'string' && options.chartName.trim()
    ? options.chartName.trim()
    : '榜单';
  const rawLimit = typeof options.limit === 'number' ? Math.round(options.limit) : 20;
  const limit = Number.isFinite(rawLimit) && rawLimit >= 1 ? rawLimit : 20;

  const title = truncate(`今日榜单速览 · ${chartName}`, TITLE_MAX);

  const list = Array.isArray(songs) ? songs.filter((s) => s && typeof s === 'object') : [];
  const picked = list.slice(0, limit);

  if (picked.length === 0) {
    return { title, description: '（榜单为空，暂无歌曲可展示）', count: 0 };
  }

  // 逐行「序号. 歌手 - 歌名（专辑）」，逐行超长先自截断（留省略标记）。
  const lines = picked.map((song, index) => {
    const artists = formatArtists(song.artists);
    const name = truncate(String(song.name ?? '未知歌曲').trim() || '未知歌曲', SONG_NAME_MAX);
    const album = formatAlbum(song.album);
    const line = `${index + 1}. ${artists} - ${name}${album ? `（${album}）` : ''}`;
    return truncate(line, LINE_MAX);
  });

  // 整体超长时按行截断，尾部保留省略标记（含被省略的歌曲数）。
  let description = lines.join('\n');
  if (description.length > DESCRIPTION_MAX) {
    const kept = [];
    let used = 0;
    for (const line of lines) {
      const cost = line.length + (kept.length > 0 ? 1 : 0);
      if (used + cost > DESCRIPTION_MAX - TRUNCATION_RESERVE) break;
      kept.push(line);
      used += cost;
    }
    const omitted = picked.length - kept.length;
    description = truncate(`${kept.join('\n')}\n${ELLIPSIS}（已省略 ${omitted} 首）`, DESCRIPTION_MAX);
  }

  return { title, description, count: picked.length };
}

module.exports = { buildDigest, truncate, formatArtists, formatAlbum, TITLE_MAX, DESCRIPTION_MAX, ELLIPSIS, SONG_NAME_MAX, LINE_MAX, TRUNCATION_RESERVE };
