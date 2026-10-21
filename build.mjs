#!/usr/bin/env node
/**
 * build.mjs —— 打包插件发布件：dist/yesplay-music-<version>.plugin.zip。
 *
 * 规则：
 *   - 打包前先跑 manifest 校验（scripts/validate-plugin-manifest.mjs），失败即中止；
 *   - zip 内只含 plugin.json / main.js / lib/ / README.md / NOTICE / LICENSE*（不含 tests、build.mjs）；
 *   - 禁止第三方依赖：zip 用 node:zlib（deflateRaw）+ 手写 ZIP 结构 + 自实现 CRC32；
 *   - 用法：node plugins/yesplay-music/build.mjs
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync, constants as zlibConstants } from 'node:zlib';

const pluginDir = dirname(fileURLToPath(import.meta.url));
const outDir = join(pluginDir, 'dist');

// ── 1. manifest 校验（打包闸门） ─────────────────────────────────────────────
// 校验脚本定位：优先用插件自带 scripts/（自包含，随仓库/拷贝任意位置都可用），
// 兼容旧布局（<repo>/plugins/yesplay-music/ 下的共享 scripts/）。
const localValidator = join(pluginDir, 'scripts', 'validate-plugin-manifest.mjs');
const legacyValidator = resolve(pluginDir, '..', '..', 'scripts', 'validate-plugin-manifest.mjs');
const validator = existsSync(localValidator) ? localValidator
  : existsSync(legacyValidator) ? legacyValidator
  : null;
if (!validator) {
  console.error('[build] 找不到 manifest 校验脚本（validate-plugin-manifest.mjs）。');
  process.exit(1);
}
const check = spawnSync(process.execPath, [validator, pluginDir], { stdio: 'inherit' });
if (check.status !== 0) {
  console.error('[build] manifest 校验未通过，已中止打包。');
  process.exit(1);
}

// ── 2. 收集打包清单 ─────────────────────────────────────────────────────────

const manifest = JSON.parse(readFileSync(join(pluginDir, 'plugin.json'), 'utf8'));
const topFiles = ['plugin.json', 'main.js', 'README.md', 'NOTICE', 'LICENSE', 'LICENSE-UPSTREAM'];
const libFiles = readdirSync(join(pluginDir, 'lib'))
  .filter((name) => name.endsWith('.js'))
  .sort()
  .map((name) => join('lib', name));

const entries = [];
for (const relPath of [...topFiles, ...libFiles]) {
  const abs = join(pluginDir, relPath);
  if (!statSync(abs).isFile()) {
    console.error(`[build] 打包清单包含非文件条目：${relPath}`);
    process.exit(1);
  }
  entries.push({ name: relPath.split('\\').join('/'), data: readFileSync(abs) });
}

// ── 3. 手写 ZIP（store 或 deflateRaw + CRC32） ──────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** DOS 时间/日期（本地时间）。 */
function dosTimeDate(date = new Date()) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, date: day };
}

function buildZip(files) {
  const { time, date } = dosTimeDate();
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const raw = file.data;
    // 小文件直接 store，省去 deflate 开销且 unzip 兼容性最好
    const deflated = deflateRawSync(raw, { level: zlibConstants.Z_BEST_COMPRESSION });
    const useDeflate = deflated.length < raw.length;
    const payload = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名标志
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra len
    localParts.push(local, nameBuf, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra len
    central.writeUInt16LE(0, 32); // comment len
    central.writeUInt16LE(0, 34); // disk start
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42); // local header offset
    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + payload.length;
    console.log(`[build]   + ${file.name}（${raw.length} B → ${payload.length} B, ${useDeflate ? 'deflate' : 'store'}）`);
  }

  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBuf, eocd]);
}

// ── 4. 写出 ─────────────────────────────────────────────────────────────────

mkdirSync(outDir, { recursive: true });
const zipName = `yesplay-music-${manifest.version}.plugin.zip`;
const zipPath = join(outDir, zipName);
const zipBuf = buildZip(entries);
writeFileSync(zipPath, zipBuf);

console.log(`[build] 打包完成：${relative(pluginDir, zipPath)}（${zipBuf.length} B，${entries.length} 个条目）`);
console.log('[build] zip 内清单：');
for (const file of entries) console.log(`[build]   - ${file.name}`);
