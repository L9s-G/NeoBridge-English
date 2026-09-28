/**
 * 官网发音音频（custom.evp_audio_files）的共享实现。
 *
 * 源库 checkpoint.json 里每行都带 `audiofilename_text`（音频文件名，如 UKACCES028），
 * 但 mp3 的真实地址**每文件唯一**、只能从 Bubble 数据类型 `custom.evp_audio_files`
 * 里换（`name_text` → `file_file`），拼不出来。
 *
 * 站点的 Data API 未开放，`/elasticsearch/*` 的请求体是加密的。加密算法逆自
 * /package/run_js/.../run.js 的 `lib-browser/db/obfuscate.js`：
 *
 *   z = AES-256-CBC( pbkdf2(md5, appname+ts, salt=appname, c=7, 32B),
 *                    pbkdf2(md5, iv,         salt=appname, c=7, 16B),
 *                    JSON.stringify(data) )
 *   y = AES(appname, "po9", `${ts}_1`)      // 服务端解出时间戳
 *   x = AES(appname, "fl1", iv)             // 服务端解出 iv
 *
 * 纯实现，浏览器那一份只用来取 cookie + 一份真实请求模板（模板里的
 * search_path / situation 等字段服务端会校验，抄现成的最稳）。
 */

import { createCipheriv, pbkdf2Sync } from 'node:crypto';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { canonicalAudioName, DETAIL_BASE } from './evp-lib.mjs';

export const APPNAME = 'english-profile';
export const SITE = 'https://englishprofile.org/?menu=evp-online';
export const SEARCH_URL = 'https://englishprofile.org/elasticsearch/search';
export const AUDIO_TYPE = 'custom.evp_audio_files';
export const PAGE_SIZE = 400;

function aes(key, iv, text, salt) {
  const dk = pbkdf2Sync(key, salt, 7, 32, 'md5');
  const div = pbkdf2Sync(iv, salt, 7, 16, 'md5');
  const cipher = createCipheriv('aes-256-cbc', dk, div);
  return Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]).toString('base64');
}

export function encodeData(data, appname = APPNAME) {
  const ts = String(Date.now());
  const iv = String(Math.random());
  return {
    z: aes(appname + ts, iv, JSON.stringify(data), appname),
    y: aes(appname, 'po9', `${ts}_1`, appname),
    x: aes(appname, 'fl1', iv, appname),
  };
}

/**
 * 打开一次真实浏览器，返回 `{ template, cookie }`。
 * `template` 是页面自己发出的一份 search 请求体（明文），后续查询以它为骨架改字段。
 */
export async function openSession({ chromium }) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.addInitScript(() => {
      window.__evpTemplates = [];
      const original = JSON.stringify;
      JSON.stringify = function patched(value, ...rest) {
        const text = original.call(this, value, ...rest);
        try {
          if (typeof text === 'string'
            && text.includes('"appname"')
            && text.includes('"constraints"')
            && text.includes('"n"')
            && !text.includes('"searches"')
            && !text.includes('"aggregates"')) {
            const parsed = JSON.parse(text);
            if (parsed.type && !window.__evpTemplates.some(t => t.type === parsed.type)) {
              window.__evpTemplates.push(parsed);
            }
          }
        } catch { /* 不是普通对象的 stringify，忽略 */ }
        return text;
      };
    });

    await page.goto(SITE, { waitUntil: 'networkidle', timeout: 90000 });
    await page.waitForTimeout(5000);

    const templates = await page.evaluate(() => window.__evpTemplates || []);
    const template = templates.find(t => t.type && typeof t.n === 'number');
    if (!template) throw new Error('未能从页面捕获 search 请求模板');

    const cookie = (await context.cookies(SITE))
      .map(c => `${c.name}=${c.value}`)
      .join('; ');

    return { page, template, cookie, close: () => browser.close() };
  } catch (err) {
    await browser.close();
    throw err;
  }
}

/**
 * 音频表里查不到的名字（源站自己也写错了 7 个）→ 打开该词条的详情页，
 * 取站点实际播放的那个 mp3。`items` 的 name 必须是规范名。
 * 返回 Map<规范名, url>。
 */
export async function resolveMissingAudio(page, items) {
  const resolved = new Map();
  for (const { name, refid } of items) {
    if (!refid) continue;
    await page.goto(`${DETAIL_BASE}${refid}`, { waitUntil: 'networkidle', timeout: 90000 });
    await page.waitForTimeout(3500);
    const src = await page.evaluate(() => {
      for (const source of document.querySelectorAll('audio source')) {
        const value = source.getAttribute('src') || '';
        if (/\.mp3(\?|$)/i.test(value)) return value;
      }
      return '';
    });
    if (src) resolved.set(canonicalAudioName(name), normalizeUrl(src));
  }
  return resolved;
}

export function buildSearch(template, { type, from, n, constraints = [] }) {
  return {
    ...template,
    type,
    constraints,
    sorts_list: [{ sort_field: 'name_text', descending: false }],
    from,
    n,
    situation: 'initial search',
  };
}

async function postSearch(template, cookie, body) {
  const res = await fetch(SEARCH_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(encodeData(body)),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`search ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

/** 整张音频表翻页抓完 → Map<name, url>（全表约 13227 行 / 34 页 / 25 秒） */
export async function fetchAudioTable(template, cookie, onPage) {
  const table = new Map();
  for (let from = 0; ; from += PAGE_SIZE) {
    const json = await postSearch(template, cookie, buildSearch(template, {
      type: AUDIO_TYPE, from, n: PAGE_SIZE,
    }));
    const hits = (json.hits && json.hits.hits) || [];
    for (const hit of hits) {
      const src = hit._source;
      if (!src || !src.file_file || !src.name_text) continue;
      table.set(String(src.name_text).trim(), normalizeUrl(src.file_file));
    }
    if (onPage) onPage({ from, hits: hits.length, total: table.size });
    if (hits.length < PAGE_SIZE) return table;
  }
}

function normalizeUrl(file) {
  const path = String(file).trim();
  return path.startsWith('http') ? path : `https:${path}`;
}

/**
 * 源数据里的音频名大小写混用（`ukcld00440` 和 `UKCLD00440` 其实是同一个文件），
 * 音频表里一律大写 → 统一按规范名（小写）匹配。
 * 返回 `{ urls: Map<规范名, url>, missing: string[]（规范名） }`。
 */
export function joinAudioUrls(neededNames, table) {
  const byName = new Map();
  for (const [name, url] of table) byName.set(canonicalAudioName(name), url);

  const urls = new Map();
  const missing = [];
  for (const name of neededNames) {
    const key = canonicalAudioName(name);
    if (!key) continue;
    const url = byName.get(key);
    if (url) urls.set(key, url);
    else missing.push(key);
  }
  return { urls, missing };
}

/** 本地文件名 = 规范名 + .mp3（规范名本身不带扩展名）。 */
export function fileNameOf(name) {
  const n = String(name).toLowerCase();
  return n.endsWith('.mp3') ? n : `${n}.mp3`;
}

/**
 * 并发下载到 destDir，**已存在且体积合法的直接跳过**（断点续传）。
 * `onProgress(processed, total)` 每处理完一个文件调一次（跳过的也算）。
 * 返回 `{ ok, skipped, failed: [{name, reason}], bytes }`。
 */
export async function downloadFiles(entries, destDir, options = {}) {
  const { concurrency = 8, minBytes = 500, onProgress = null } = options;
  mkdirSync(destDir, { recursive: true });

  const total = entries.length;
  const queue = [...entries];
  const failed = [];
  let ok = 0;
  let skipped = 0;
  let bytes = 0;
  let processed = 0;

  const tick = () => {
    processed += 1;
    if (onProgress) onProgress(processed, total);
  };

  const alive = file => {
    try {
      const stat = statSync(join(destDir, file));
      return stat.isFile() && stat.size >= minBytes;
    } catch { return false; }
  };

  async function worker() {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      const { name, url } = item;
      const file = fileNameOf(name);

      if (alive(file)) { skipped += 1; tick(); continue; }

      let lastReason = '';
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const type = res.headers.get('content-type') || '';
          if (!/mpeg|audio/i.test(type)) throw new Error(`content-type ${type}`);
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length < minBytes) throw new Error(`只有 ${buf.length} 字节`);
          writeFileSync(join(destDir, file), buf);
          bytes += buf.length;
          ok += 1;
          lastReason = '';
          break;
        } catch (err) {
          lastReason = err.message;
        }
      }
      if (lastReason) failed.push({ name, reason: lastReason });
      tick();
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, total || 1) }, worker));
  return { ok, skipped, failed, bytes };
}

export function countExisting(dir, names) {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const name of names) {
    try {
      if (statSync(join(dir, fileNameOf(name))).size > 0) n += 1;
    } catch { /* 缺文件 */ }
  }
  return n;
}
