#!/usr/bin/env node
/**
 * 抓官网音频表 custom.evp_audio_files → data/raw/audio-files.json
 *
 *   node scripts/scrape-audio-urls.mjs
 *   npm run scrape:audio
 *
 * 全表约 13227 行，按 name_text 排序翻页（每页 400）约 34 次请求、18 秒。
 * 存全表而不是只存用得到的 3708 个：以后加 C2 包不用重抓。
 *
 * 源站有 7 个音频名在音频表里根本不存在（ukrefre008 这类手误），
 * 这些走详情页兜底：取站点实际播放的那个 mp3。
 *
 * 只在音频表变化时需要；`npm run rebuild` / `npm run audio` 都只读这个 JSON，不联网。
 */

import { chromium } from 'playwright-core';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchAudioTable, joinAudioUrls, openSession, resolveMissingAudio } from './audio-lib.mjs';
import { canonicalAudioName } from './evp-lib.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RAW_DIR = join(ROOT, 'data', 'raw');
const OUT = join(RAW_DIR, 'audio-files.json');
const CHECKPOINT = join(RAW_DIR, 'checkpoint.json');

/** 源库里带 audiofilename 的行 → Map<规范名, refid>（详情页兜底要用 refid） */
function sourceAudioNames() {
  if (!existsSync(CHECKPOINT)) return null;
  const cp = JSON.parse(readFileSync(CHECKPOINT, 'utf8'));
  const map = new Map();
  for (const r of cp.records || []) {
    const name = canonicalAudioName(r.audiofilename_text);
    if (!name) continue;
    if (!map.has(name)) map.set(name, r.refid_text || null);
  }
  return map;
}

async function main() {
  mkdirSync(RAW_DIR, { recursive: true });

  console.log('[1/4] 打开站点取 cookie 与请求模板...');
  const session = await openSession({ chromium });

  let table;
  let fallback = 0;
  try {
    console.log('[2/4] 翻页抓取音频表...');
    const t0 = Date.now();
    let pages = 0;
    table = await fetchAudioTable(session.template, session.cookie, ({ from, hits, total }) => {
      pages += 1;
      if (pages % 5 === 0 || from === 0) {
        console.log(`      from=${from}  hits=${hits}  distinct=${total}`);
      }
    });
    console.log(`      ${pages} 页 / ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    const source = sourceAudioNames();
    if (source) {
      const { missing } = joinAudioUrls([...source.keys()], table);
      if (missing.length) {
        console.log(`[3/4] 音频表里查不到 ${missing.length} 个，走详情页兜底...`);
        const items = missing.map(name => ({ name, refid: source.get(name) }));
        const extra = await resolveMissingAudio(session.page, items);
        for (const [name, url] of extra) table.set(name, url);
        fallback = extra.size;
        console.log(`      兜底拿到 ${extra.size} 个，仍缺 ${missing.length - extra.size} 个（官网本身也没有）`);
      } else {
        console.log('[3/4] 全部命中，无需兜底');
      }
    } else {
      console.log('[3/4] 没有 checkpoint.json，跳过覆盖率检查');
    }
  } finally {
    await session.close();
  }

  const payload = {
    scrapedAt: new Date().toISOString(),
    source: 'custom.evp_audio_files',
    count: table.size,
    files: Object.fromEntries([...table.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
  };
  writeFileSync(OUT, JSON.stringify(payload));
  console.log(`[4/4] → ${OUT}`);

  const source = sourceAudioNames();
  if (source) {
    const { urls, missing } = joinAudioUrls([...source.keys()], table);
    console.log(`\n  源库需要的音频名 : ${source.size}`);
    console.log(`  能解析出 URL     : ${urls.size}`);
    console.log(`  其中详情页兜底   : ${fallback}`);
    console.log(`  解析不到         : ${missing.length}${missing.length ? '  ' + missing.join(', ') : ''}`);
  }
  console.log(`  音频表总行数     : ${table.size}`);
}

main().catch(err => {
  console.error('\nFAILED:', err.message);
  process.exit(1);
});
