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

const SHELL_CACHE = 'neobridge-shell-v20';   // ← 发版时改这里（v20：llm 开发测试页不进缓存）
const PACK_CACHE_PREFIX = 'neobridge-pack-';
// 与 app/js/ui/audio-download.js 里的 AUDIO_CACHE 保持一致（sw.js 是经典脚本，不能 import）
const AUDIO_CACHE = 'neobridge-audio-v1';

const SHELL = [
  './',
  './index.html',
  './app.css',
  './manifest.webmanifest',
  './icon.svg',
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
  './js/db/idb.js',
  './js/db/stores.js',
  './js/db/importer.js',
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
  // 数据文件（词包清单 / 词包本体）必须网络优先：缓存里那份旧 manifest 会让人下到旧版词包，
  // 旧词包没有 a 字段 → 整页卡片都退回 YouGlish。在线时以服务器为准，离线才回退缓存。
  if (isDataUrl(request.url)) return networkFirst(request);

  const hit = await caches.match(request, { ignoreSearch: true });
  if (hit) return hit;

  try {
    const res = await fetch(request);
    if (res.ok && res.type === 'basic') {
      // 发音进独立缓存：SHELL_CACHE 换名时不会连坐清掉 23 MB 音频
      const cache = await caches.open(isAudioUrl(request.url) ? AUDIO_CACHE : SHELL_CACHE);
      await cache.put(request, res.clone());
    }
    return res;
  } catch (err) {
    // 离线导航兜底到外壳
    if (request.mode === 'navigate') {
      const shell = await caches.match('./index.html');
      if (shell) return shell;
    }
    throw err;
  }
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
  return path.endsWith('/data/manifest.json') || /\/data\/words[^/]*\.json$/.test(path);
}

function isAudioUrl(url) {
  return new URL(url).pathname.indexOf('/audio/') >= 0;
}
