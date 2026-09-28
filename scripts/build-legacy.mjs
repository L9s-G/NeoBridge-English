#!/usr/bin/env node
/**
 * 生成旧版入口（iOS 12 / Safari 12）：
 *
 *   app/legacy.js    js/app.js 整棵模块图打成一个经典脚本（iife，target=safari12）
 *                    —— esbuild 机械降级 ?. / ?? 等 Safari 13.1+ 语法，
 *                    运行时 API（replaceChildren / 剪贴板 / crypto.subtle）的
 *                    兜底写在共享源码里，这里不处理。
 *   app/legacy.html  由 index.html 派生：去 manifest（= 不注册 Service Worker）、
 *                    module script 换成经典脚本、入口链接改为指回新版。
 *
 * 产物入库（Cloudflare 照旧零构建部署）。改了 app/js 后必须重跑本脚本，
 * tests/legacy.test.js 会重新构建并与产物比对，忘了跑就测试红。
 *
 *   npm run build:legacy
 */
import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const APP = join(ROOT, 'app');

/** 构建参数；测试直接复用这一份，保证「测的就是产的」 */
export const BUILD_OPTIONS = {
  entryPoints: [join(APP, 'js', 'app.js')],
  bundle: true,
  format: 'iife',
  target: 'safari12',
  // esbuild 的 destructuring 兼容数据保守到 Safari 15（实际 Safari 10+ 就支持，
  // iOS 12 解构没问题），声明该项已支持，让 ?. / ?? 等真正需要的降级照常进行
  supported: { destructuring: true },
  platform: 'browser',
  legalComments: 'none',
  logLevel: 'silent',
};

/** 构建 legacy.js 内存产物（不落盘） */
export async function buildLegacyJs() {
  const result = await build({ ...BUILD_OPTIONS, write: false });
  return result.outputFiles[0].text;
}

/** index.html → legacy.html；index.html 结构变化会让这里立刻抛错，不会静默生成坏页面 */
export function buildLegacyHtml(modernHtml) {
  let html = modernHtml;
  const swap = (re, replacement, what) => {
    if (!re.test(html)) throw new Error(`legacy.html 生成失败：index.html 里找不到 ${what}`);
    html = html.replace(re, replacement);
  };

  // 没有 manifest link ⇒ app.js 里的 IS_LEGACY 为真 ⇒ 不注册 SW、不显示发音下载卡
  swap(/<link rel="manifest"[^>]*>\n/, '', 'manifest link');
  swap(
    /<title>(.*?)<\/title>/,
    (m, title) => `<title>${title}（旧版）</title>`,
    '<title>',
  );
  swap(
    /<script type="module" src="\.\/js\/app\.js"><\/script>/,
    '<script src="./legacy.js"></script>',
    'module script',
  );
  swap(
    /<p class="legacy-row">[\s\S]*?<\/p>/,
    '<p class="legacy-row"><a class="legacy-link" href="./index.html">这是旧版入口，新版（PWA）在首页 →</a></p>',
    'legacy-row 入口链接',
  );
  return html;
}

async function main() {
  const modernHtml = await readFile(join(APP, 'index.html'), 'utf8');
  const js = await buildLegacyJs();
  const html = buildLegacyHtml(modernHtml);

  await writeFile(join(APP, 'legacy.js'), js);
  await writeFile(join(APP, 'legacy.html'), html);
  console.log(`app/legacy.js   ${(js.length / 1024).toFixed(1)} KB（target=safari12）`);
  console.log('app/legacy.html 已生成（无 manifest / 无 module script）');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
