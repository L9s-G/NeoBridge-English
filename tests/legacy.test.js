/**
 * 旧版入口（legacy）的构建保障：
 *   1. esbuild（target=safari12）构建成功 —— 语法兼容由构建机械保证
 *   2. 产物里没有旧浏览器解析不了的 token —— 二道保险
 *   3. 入库产物 == 重新构建 —— 改了 app/js 忘跑 npm run build:legacy 时变红
 *   4. legacy.html 结构正确（无 manifest、无 module script）
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { buildLegacyHtml, buildLegacyJs } from '../scripts/build-legacy.mjs';

const APP = join(dirname(dirname(fileURLToPath(import.meta.url))), 'app');

test('legacy.js 构建成功且不含 Safari 12 解析不了的语法', async () => {
  const js = await buildLegacyJs();

  // ?. 与 ?? —— Safari 13.1+；iOS 12 上是 SyntaxError，会杀掉整个脚本
  assert.ok(!/\?\./.test(js), '产物含 ?. （可选链）');
  assert.ok(!/\?\?/.test(js), '产物含 ?? （空值合并）');
  // 这两个是 API 不是语法，esbuild 不管 —— 共享源码里必须已经改成回退写法
  assert.ok(!/\.replaceChildren\(/.test(js), '产物调用了 replaceChildren 方法（Safari 14+）');
  assert.ok(!/globalThis/.test(js), '产物引用了 globalThis（Safari 12.1+）');
});

test('入库的 app/legacy.js 与重新构建一致（防漂移）', async () => {
  const fresh = await buildLegacyJs();
  const committed = readFileSync(join(APP, 'legacy.js'), 'utf8');
  assert.equal(
    fresh, committed,
    'app/legacy.js 已过期 —— 改了 app/js 之后运行 npm run build:legacy 并重新提交产物',
  );
});

test('legacy.html 由 index.html 正确派生', () => {
  const html = readFileSync(join(APP, 'legacy.html'), 'utf8');
  const modern = readFileSync(join(APP, 'index.html'), 'utf8');

  assert.ok(!/rel="manifest"/.test(html), 'legacy.html 不能带 manifest（= 不注册 SW 的入口信号）');
  assert.ok(!/type="module"/.test(html), 'legacy.html 不能用 module script');
  assert.ok(/<script src="\.\/legacy\.js"><\/script>/.test(html), '应加载经典脚本 legacy.js');
  assert.ok(!/js\/app\.js/.test(html), '不应引用模块版 app.js');
  assert.ok(/href="\.\/index\.html"/.test(html), '应有回新版入口的链接');

  // 派生关系：除四处替换外，其余必须与 index.html 逐字一致
  const reparsed = buildLegacyHtml(modern);
  assert.equal(reparsed, html, 'legacy.html 与 index.html 的派生关系断了（产物过期？）');
  assert.ok(/rel="manifest"/.test(modern), 'index.html 必须保留 manifest（新版走 PWA）');
  assert.ok(/type="module"/.test(modern), 'index.html 必须保留 module script');
});

test('legacy.html 与 index.html 标题/品牌一致', () => {
  const html = readFileSync(join(APP, 'legacy.html'), 'utf8');
  const modern = readFileSync(join(APP, 'index.html'), 'utf8');
  const title = html.match(/<title>(.*?)<\/title>/)[1];
  const modernTitle = modern.match(/<title>(.*?)<\/title>/)[1];

  assert.equal(title, `${modernTitle}（旧版）`, '标题应 = 新版标题 +（旧版）');
  assert.equal(
    html.match(/<h1 class="title">(.*?)<\/h1>/)[1],
    modern.match(/<h1 class="title">(.*?)<\/h1>/)[1],
    '品牌名（h1）应与 index.html 一致',
  );
});
