/**
 * Service Worker：离线外壳 + 词包预缓存 + 发音缓存。
 *
 * 缓存分三个：
 *   shell  —— 页面与代码，名字里带版本号，**发新版本时把 SHELL_CACHE 改掉**
 *   pack   —— 词包，名字里带 manifest.sha256，换包自动换缓存
 *   audio  —— 官网发音 mp3（设置页「下载全部发音」逐个写入，约 23 MB），
 *             名字里带版本号；它**不随发版删除**，换版本只换 shell 缓存。
 *
 * 词包只在 install 时抓一次，装不下就安装失败（保证离线可用）。
 * 真正决定"用哪份数据"的是 IndexedDB 里的记录 + importer 的校验，
 * 所以 SW 缓存过期最多少拿一次，不会读到损坏数据。
 */

const SHELL_CACHE = 'neobridge-shell-v24';   // ← 发版时改这里（v24：图标换成设计好的 PNG/ICO 套件）
const PACK_CACHE_PREFIX = 'neobridge-pack-';
// 与 app/js/ui/audio-download.js 里的 AUDIO_CACHE 保持一致（sw.js 是经典脚本，不能 import）
const AUDIO_CACHE = 'neobridge-audio-v1';

// 预缓存清单：**只列规范 URL**。入口一律是根路径 `/`，不要再加 './index.html'
// —— 那份是同一页面的重复条目，而且边缘若对 .html 回 3xx，addAll 跟过去存下的
// 响应带 redirected 标志，会给导航埋雷（见下面 asNavigation 的注释）。
// 图标（favicon.ico / apple-touch-icon.png / icon-*.png，共约 610 KB）**不预缓存**：
// 标签页和「添加到主屏幕」都是浏览器自己去取 manifest 里的图，离线用不到。
const SHELL = [
  './',
  './app.css',
  './manifest.webmanifest',
  './js/app.js',
  './js/core/params.js',
  './js/core/mastery.js',
  './js/core/sha256.js',
  './js/core/weight.js',
  './js/core/pools.js',
  './js/core/progress.js',
  './js/core/scheduler.js',
  './js/core/queue.js',
  './js/core/day.js',
  './js/core/dict.js',
  './js/db/idb.js',
  './js/db/stores.js',
  './js/db/importer.js',
  './js/db/ext-loader.js',
  './js/ui/views.js',
  './js/ui/card-info.js',
  './js/ui/audio-download.js',
  './js/ui/session.js',
  './js/ui/lists.js',
  './data/manifest.json',
];

self.addEventListener('install', event => {
  event.waitUntil(installAll());
});

async function installAll() {
  const shell = await caches.open(SHELL_CACHE);
  await shell.addAll(SHELL);

  const res = await fetch('./data/manifest.json');
  const manifest = await res.clone().json();
  await shell.put('./data/manifest.json', res);

  const packName = PACK_CACHE_PREFIX + manifest.sha256;
  const pack = await caches.open(packName);
  await pack.add('./data/' + manifest.file);

  // 旧词包缓存立刻让位，省空间
  const names = await caches.keys();
  await Promise.all(
    names
      .filter(n => n.startsWith(PACK_CACHE_PREFIX) && n !== packName)
      .map(n => caches.delete(n)),
  );

  await self.skipWaiting();
}

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter(n => n.startsWith('neobridge-shell-') && n !== SHELL_CACHE)
        .map(n => caches.delete(n)),
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;
  // 开发专用：llm 测试页（未部署）与 /llm 反代直连网络，不落 shell 缓存，
  // 否则 cache-first 会把改动锁在旧版本里
  const path = new URL(request.url).pathname;
  if (path.endsWith('/llm-test.html') || path.indexOf('/llm/') > -1) return;
  event.respondWith(handle(request));
});

async function handle(request) {
  const path = new URL(request.url).pathname;
  // 扩展正文（约 4 MB）由 ext-loader 自管独立缓存 neobridge-ext（按 manifest sha 增量更新）：
  // SW 只放行，绝不落 SHELL 缓存 —— 双份浪费是其次，cache-first 锁旧才是要命的
  // （caches.match 跨缓存搜索，连 loader 自己存的新版都会被当成"命中"直接返回旧响应）。
  // 离线时 fetch 抛错 → loader 捕获后读自己的缓存兜底。
  if (path.endsWith('/data/ext.v1.json')) return fetch(request);

  // 数据文件（词包清单 / 扩展清单 / 词包本体）必须网络优先：缓存里那份旧 manifest 会让人下到旧版词包，
  // 旧词包没有 a 字段 → 整页卡片都退回 YouGlish。在线时以服务器为准，离线才回退缓存。
  if (isDataUrl(request.url)) return networkFirst(request);

  const hit = await caches.match(request, { ignoreSearch: true });
  if (hit) return asNavigation(request, hit);

  try {
    const res = await fetch(request);
    if (res.ok && res.type === 'basic') {
      // 发音进独立缓存：SHELL_CACHE 换名时不会连坐清掉 23 MB 音频
      const cache = await caches.open(isAudioUrl(request.url) ? AUDIO_CACHE : SHELL_CACHE);
      await cache.put(request, res.clone());
    }
    // 导航请求拿到的是 opaqueredirect —— 合法，浏览器会自己去跟这个跳转。
    // asNavigation 主要救的是下面这条：缓存里存着跟过 3xx 的响应（redirected=true）。
    return asNavigation(request, res);
  } catch (err) {
    // 离线导航兜底到外壳（清单里只有规范 URL 这一个入口页）
    if (request.mode === 'navigate') {
      const shell = await caches.match('./');
      if (shell) return asNavigation(request, shell);
    }
    throw err;
  }
}

/**
 * 给导航请求用的响应「洗掉」redirected 标志。
 *
 * 导航请求的 redirect mode 是 manual，浏览器规定：响应只要带 redirected 标志，
 * 就判成网络错误 —— 白屏，console 报
 *   The FetchEvent for "…" resulted in a network error response: a redirected
 *   response was used for a request whose redirect mode is not "follow".
 * 边缘（Cloudflare auto-traffic 会把 /index.html 307 到 /、/legacy.html 307 到
 * /legacy；某些防火墙/网关也会 3xx）随时可能给路径回跳转。凡是**跟着 3xx 存进缓存**
 * 的响应都带着这个标志（install 的 addAll、运行时 cache.put 都会），之后导航命中
 * 它就白屏。所以这里把响应重建成一个干净的（redirected=false）副本 —— 入口本身用
 * 规范 URL（`./`）是第一道防线，这一层是第二道。
 * 非导航请求原样返回（子资源用 manual 之外的 redirect mode 不受影响）。
 */
function asNavigation(request, res) {
  if (request.mode !== 'navigate' || !res.redirected) return res;
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

async function networkFirst(request) {
  try {
    const res = await fetch(request);
    if (res.ok && res.type === 'basic') {
      await (await caches.open(SHELL_CACHE)).put(request, res.clone());
    }
    return res;
  } catch (err) {
    const hit = await caches.match(request, { ignoreSearch: true });
    if (hit) return hit;
    throw err;
  }
}

function isDataUrl(url) {
  const path = new URL(url).pathname;
  return path.endsWith('/data/manifest.json')
    || path.endsWith('/data/manifest-ext.json')
    || /\/data\/words[^/]*\.json$/.test(path);
}

function isAudioUrl(url) {
  return new URL(url).pathname.indexOf('/audio/') >= 0;
}
