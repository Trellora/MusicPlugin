/**
 * tests/lyrics.test.js —— lib/lyrics.js 的 LRC 解析纯函数测试。
 * 运行：node --test plugins/yesplay-music/tests
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseLrc, extractOffsetMs } = require('../lib/lyrics');

test('基础解析：时间标签 → {timeMs, text} 并升序输出', () => {
  const lrc = [
    '[00:12.00]第一行歌词',
    '[00:05.50]更早的一行',
    '[01:02.30]最后一行',
  ].join('\n');
  const parsed = parseLrc(lrc);
  assert.equal(parsed.length, 3);
  assert.deepEqual(parsed.map((e) => e.text), ['更早的一行', '第一行歌词', '最后一行']);
  assert.equal(parsed[0].timeMs, 5500);
  assert.equal(parsed[1].timeMs, 12000);
  assert.equal(parsed[2].timeMs, 62300);
});

test('一行多标签：[00:10.00][00:50.00]副歌 → 展开为两条', () => {
  const parsed = parseLrc('[00:10.00][00:50.00]副歌');
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].timeMs, 10000);
  assert.equal(parsed[1].timeMs, 50000);
  assert.equal(parsed[0].text, '副歌');
  assert.equal(parsed[1].text, '副歌');
});

test('元信息行忽略：[ti:] [ar:] [by:] 不产生歌词条目', () => {
  const lrc = ['[ti:晴天]', '[ar:周杰伦]', '[by:某人]', '[00:01.00]正文'].join('\n');
  const parsed = parseLrc(lrc);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].text, '正文');
});

test('offset 应用：[offset:500] 让所有条目平移 +500ms，[offset:-300] 平移 -300ms', () => {
  const positive = parseLrc('[offset:500]\n[00:10.00]A');
  assert.equal(positive[0].timeMs, 10500);
  const negative = parseLrc('[offset:-300]\n[00:10.00]A');
  assert.equal(negative[0].timeMs, 9700);
  assert.equal(extractOffsetMs('[offset:500]'), 500);
});

test('空歌词与非法输入：空串 / null / 纯标签行 → []', () => {
  assert.deepEqual(parseLrc(''), []);
  assert.deepEqual(parseLrc('   '), []);
  assert.deepEqual(parseLrc(null), []);
  assert.deepEqual(parseLrc(undefined), []);
  assert.deepEqual(parseLrc(42), []);
  assert.deepEqual(parseLrc('[00:10.00]'), []); // 纯标签、无文本 → 过滤
  assert.deepEqual(parseLrc('[00:10.00]   '), []); // 文本全是空白 → 过滤
});

test('毫秒位宽容：[00:01.5] [00:01.50] [00:01.500] 均为 1500ms', () => {
  for (const tag of ['[00:01.5]', '[00:01.50]', '[00:01.500]']) {
    const parsed = parseLrc(`${tag}X`);
    assert.equal(parsed[0].timeMs, 1500, `标签 ${tag} 应解析为 1500ms`);
  }
});

test('非法时间戳忽略：秒 ≥60 的标签行不产生条目', () => {
  assert.deepEqual(parseLrc('[00:75.00]坏行'), []);
});
