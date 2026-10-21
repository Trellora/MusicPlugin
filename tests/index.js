/**
 * tests/index.js —— 测试兼容入口。
 *
 * `node --test plugins/yesplay-music/tests` 在部分 Node 版本（实测 v26）会把目录参数
 * 当作入口模块解析而不是扫描目录。本文件让目录可以被解析（CJS 目录入口），
 * 载入全部 *.test.js，保证上述命令在新旧 Node 上都全绿。
 *
 * 也可以直接按 glob 跑：node --test "plugins/yesplay-music/tests/*.test.js"
 */

'use strict';

require('./lyrics.test.js');
require('./digest.test.js');
require('./cache.test.js');
require('./config.test.js');
require('./netease.test.js');
require('./boundary.test.js');
