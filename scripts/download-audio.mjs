#!/usr/bin/env node
/**
 * 把官网发音 mp3 下载到 app/audio/（离线 PWA 用）
 *
 *   node scripts/download-audio.mjs
 *   npm run audio
 *   node scripts/download-audio.mjs --concurrency 4
 *
 * 清单来自 data/raw/audio-files.json（`npm run scrape:audio` 产出），
 * 要下哪些文件名由 data/raw/checkpoint.json 里带 audiofilename 的行决定。
 *
 * 已存在且体积合法的文件直接跳过 —— 中断后重跑同命令即可续传。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { downloadFiles, joinAudioUrls } from './audio-lib.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const AUDIO_DIR = join(ROOT, 'app', 'audio');
const AUDIO_FILES = join(ROOT, 'data', 'raw', 'audio-files.json');
const CHECKPOINT = join(ROOT, 'data', 'raw', 'checkpoint.json');

const args = process.argv.slice(2);
const flag = args.indexOf('--concurrency');
const CONCURRENCY = flag >= 0 ? Number(args[flag + 1]) : 8;

function neededNames() {
  const cp = JSON.parse(readFileSync(CHECKPOINT, 'utf8'));
  return [...new Set(
    (cp.records || [])
      .filter(r => r.audiofilename_text)
      .map(r => String(r.audiofilename_text).trim()),
  )];
}

function audioTable() {
  const payload = JSON.parse(readFileSync(AUDIO_FILES, 'utf8'));
  return new Map(Object.entries(payload.files));
}

async function main() {
  const names = neededNames();
  const { urls, missing } = joinAudioUrls(names, audioTable());

  const entries = [...urls.entries()].map(([name, url]) => ({ name, url }));
  console.log(`清单：源库 ${names.length} 个音频名，${entries.length} 个可下载`);
  if (missing.length) console.log(`官网没有的 ${missing.length} 个：${missing.join(', ')}`);

  const t0 = Date.now();
  let lastLog = 0;
  const result = await downloadFiles(entries, AUDIO_DIR, {
    concurrency: CONCURRENCY,
    onProgress: (done, total) => {
      if (done - lastLog >= 100 || done === total) {
        lastLog = done;
        process.stdout.write(`\r  ${done}/${total}`);
      }
    },
  });
  process.stdout.write('\r');

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  新下载 : ${result.ok} 个（${(result.bytes / 1024 / 1024).toFixed(2)} MB）`);
  console.log(`  已存在 : ${result.skipped} 个`);
  console.log(`  失败   : ${result.failed.length}`);
  for (const f of result.failed) console.log(`    ${f.name}  ${f.reason}`);
  console.log(`  目录   : ${AUDIO_DIR}  用时 ${secs}s`);

  if (result.failed.length) process.exitCode = 2;
}

main().catch(err => {
  console.error('\nFAILED:', err.message);
  process.exit(1);
});
