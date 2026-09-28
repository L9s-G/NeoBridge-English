/**
 * 官网发音（app/audio/*.mp3）的本地缓存与播放。
 *
 * 存放位置是 Cache Storage（不是 IndexedDB）：Service Worker 拦同源 GET 就能直接回，
 * 播放时不需要先读出来再拼 Blob。
 *
 * 缓存名必须与 sw.js 里的 AUDIO_CACHE 一致 —— sw.js 是经典脚本、不能 import，
 * 两边各写一份，改名时同步改。
 *
 * 两条路径：
 *   1. 设置页「下载全部发音」→ 本文件逐个 fetch + put，可中断、可续传
 *   2. 答题卡上点 🔊        → 直接给 <audio> 塞同源 URL，SW 命中缓存就离线可播；
 *                              没下载过但在线，这次播放会顺手把文件写进缓存
 */

// 同 app/sw.js 的 AUDIO_CACHE（sw.js 不能 import 模块）
export const AUDIO_CACHE = 'neobridge-audio-v1';

const MIN_BYTES = 500;

export function audioUrl(name) {
  return `./audio/${name}.mp3`;
}

/** 词包里全部发音文件名（去重、排序）—— 下载清单就是这个 */
export function audioNamesOf(payload) {
  const set = new Set();
  for (const word of payload?.words || []) {
    for (const sense of word.senses || []) if (sense.a) set.add(sense.a);
  }
  return [...set].sort();
}

/** 已经在缓存里的数量；传 names 时返回其中已缓存的子集数量 */
export async function countCached(names) {
  if (typeof caches === 'undefined') return 0;
  const cache = await caches.open(AUDIO_CACHE);
  const keys = await cache.keys();
  const have = new Set(keys.map(k => nameOf(k.url)));
  return names ? names.filter(n => have.has(n)).length : have.size;
}

function nameOf(url) {
  const path = new URL(url).pathname;
  const base = path.slice(path.lastIndexOf('/') + 1);
  return base.endsWith('.mp3') ? base.slice(0, -4) : base;
}

/**
 * 逐个下载，已缓存的直接跳过（中断后重跑即可续传）。
 * `onProgress(state)` 每处理完一个文件调一次，state 见函数返回值。
 * 返回 `{ total, done, ok, skipped, failed: [{name, reason}], bytes }`。
 */
export async function downloadAudio(names, options = {}) {
  const { concurrency = 6, onProgress = null } = options;
  const cache = await caches.open(AUDIO_CACHE);
  const queue = [...names];
  const state = {
    total: names.length, done: 0, ok: 0, skipped: 0, failed: [], bytes: 0,
  };
  const tick = () => {
    state.done += 1;
    if (onProgress) onProgress(state);
  };

  async function worker() {
    for (;;) {
      const name = queue.shift();
      if (!name) return;
      const url = audioUrl(name);
      try {
        if (await cache.match(url)) { state.skipped += 1; tick(); continue; }
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        if (buf.byteLength < MIN_BYTES) throw new Error(`只有 ${buf.byteLength} 字节`);
        await cache.put(url, new Response(buf, { headers: { 'Content-Type': 'audio/mpeg' } }));
        state.bytes += buf.byteLength;
        state.ok += 1;
      } catch (err) {
        state.failed.push({ name, reason: err?.message || String(err) });
      }
      tick();
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length || 1) }, worker));
  return state;
}

/* ---------------- 播放 ---------------- */

let player = null;
let lastNames = null;
let cursor = 0;

/** 同一张卡多次点 🔊 会轮流播它不同的发音（increase 名动重音不同） */
function pick(names) {
  const key = names.join('|');
  if (key !== lastNames) { lastNames = key; cursor = 0; }
  const name = names[cursor % names.length];
  cursor += 1;
  return name;
}

/**
 * 播本地发音。失败（离线且没下载）时给一句提示 —— 答题页没有 toast，
 * 用 alert 与项目里 confirm 删除词包的做法保持一致。
 */
export function playAudio(names) {
  if (!names || !names.length) return;
  const name = pick(names);
  if (!player) player = new Audio();
  player.src = audioUrl(name);
  player.currentTime = 0;
  const playing = player.play();
  if (playing && playing.catch) {
    playing.catch(err => {
      console.warn('发音播放失败：', name, err);
      alert('发音暂时无法播放：\n既没有下载到本地，当前也不在线。\n\n可在「设置 → 发音」一次性下载全部发音。');
    });
  }
}

/** 一张卡要播的发音列表（去重保序，取义项里的 a） */
export function audioNamesOfWord(word) {
  const seen = [];
  for (const sense of word?.senses || []) {
    if (sense.a && !seen.includes(sense.a)) seen.push(sense.a);
  }
  return seen;
}
