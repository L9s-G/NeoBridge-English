#!/usr/bin/env node
/**
 * 把 data/evp.sqlite 打成 PWA 用的只读 DLC 词包。
 *
 *   node scripts/build-dataset.mjs
 *   npm run build:pack
 *
 * 输出
 *   app/data/words.v2.json   词包正文（5008 词 / 7101 义项）+ 自解释的包头
 *   app/data/manifest.json   包描述 + sha256，DLC 换包校验用
 *
 * 词包里只存站点标识（refid）与发音文件名（a），不存派生 URL：链接由词包头部的
 * baseUrl 在运行时拼出来，音频文件名对应 app/audio/<a> 的本地文件。
 *
 * 为什么要"打一个包"而不是让 app 直接读 SQLite？
 *   1. app 是纯 HTML+JS 的 PWA，不带 wasm 版 SQLite，JSON 是最省事的格式；
 *   2. 用户的产品模型是"主库不动、整包替换"——新增 C2 等级就是新增一个包，
 *      旧包与本地进度互不影响，进度主键是 wordKey 而不是行号。
 *
 * 构建期一次性做完所有加工（去方括号、拆句、聚合成词），运行时零成本。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';

import { DETAIL_BASE } from './evp-lib.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DB_PATH = join(ROOT, 'data', 'evp.sqlite');
const AUDIO_DIR = join(ROOT, 'app', 'audio');
const OUT_DIR = join(ROOT, 'app', 'data');

const PACK_ID = 'evp-uk-b1b2';
const PACK_VERSION = 2;
const SCHEMA_VERSION = 1;
const LEVELS = ['B1', 'B2'];

// 与 scripts/evp-lib.mjs 保持一致的预期值（换包或改抓取条件时同步改这里）
const EXPECT = {
  rows: 7101,
  words: 5008,
  byLevel: { B1: 2937, B2: 4164 },
  sensesWithExamples: 7095,
  sensesWithAudio: 5455,
  distinctAudio: 3701,
};

/* ------------------------------------------------------------------ *
 * 清洗
 * ------------------------------------------------------------------ */

/**
 * 例句里的方括号是 Cambridge 编辑对学习者原文"外围错误"的修正标记
 * （Capel 2010/2012, English Profile Journal：
 *  "errors ... are corrected within square brackets"）。
 * 删掉括号、保留内容，得到的就是修正后的正确句子。
 *
 * 唯一的边角：修正内容以小写字母结尾、而紧随其后是大写字母时，源数据
 * 少了一个空格（全库仅 1 处 `see [the]Vatican`），此时补一个空格。
 *
 * 输入原始 examples 字符串（多句以 ; 分隔），输出清洗后的句子数组。
 */
export function cleanExamples(raw) {
  if (!raw) return [];

  let stripped = '';
  let cursor = 0;
  const bracket = /\[([^\]]*)\]/g;
  let m;
  while ((m = bracket.exec(raw)) !== null) {
    stripped += raw.slice(cursor, m.index);
    const inner = m[1];
    const next = raw[m.index + m[0].length] || '';
    const needsSpace = /[a-z]$/.test(inner) && /^[A-Z]/.test(next);
    stripped += inner + (needsSpace ? ' ' : '');
    cursor = m.index + m[0].length;
  }
  stripped += raw.slice(cursor);

  return stripped
    .split(';')
    .map(s => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/** 进度主键：源数据里大小写变体已验证为 0 冲突，可安全归一。 */
export function wordKeyOf(baseWord) {
  return baseWord.trim().toLowerCase();
}

/** app/audio/ 里真实存在的发音文件名（去 .mp3 后的规范名）集合。 */
export function audioFiles(dir) {
  if (!existsSync(dir)) return new Set();
  return new Set(
    readdirSync(dir)
      .filter(f => f.endsWith('.mp3'))
      .map(f => f.slice(0, -4).toLowerCase()),
  );
}

/** 这批发音文件的总字节数（设置页"下载全部发音"的容量提示用这个口径）。 */
export function countAudioBytes(names, dir) {
  let total = 0;
  for (const n of names) {
    try { total += statSync(join(dir, `${n}.mp3`)).size; } catch { /* 缺文件忽略 */ }
  }
  return total;
}

/* ------------------------------------------------------------------ *
 * 聚合
 * ------------------------------------------------------------------ */

/**
 * 7101 行（词 × 义项）→ 5008 个词，每个词下挂自己的义项数组。
 * 词级只放跨义项不变的东西，义项级放每个义项各自的字段。
 */
export function buildWords(rows) {
  const byKey = new Map();

  for (const r of rows) {
    const key = wordKeyOf(r.base_word);
    let word = byKey.get(key);
    if (!word) {
      word = { k: key, w: r.base_word.trim(), levels: new Set(), entries: new Set(), zh: null, senses: [] };
      byKey.set(key, word);
    }

    word.levels.add(r.level);
    if (r.entry_refid) word.entries.add(r.entry_refid);

    word.senses.push({
      hw: r.headword || null,
      guide: r.guideword || null,
      level: r.level,
      pos: r.pos || null,
      topic: r.topic || null,
      def: r.definition || null,
      ipa: r.pronunciation || null,
      ex: cleanExamples(r.examples),
      // 本地发音文件名 → app/audio/<a>.mp3；null 表示官网没有这段音频
      a: r.audio_name || null,
      // 只存站点标识，不存派生 URL —— 链接 = payload.baseUrl + refid
      refid: r.refid || null,
    });
  }

  const words = [...byKey.values()];
  for (const w of words) {
    w.levels = [...w.levels].sort();
    w.entries = [...w.entries].sort();
    w.senses.sort(bySense);
  }
  words.sort((a, b) => a.k.localeCompare(b.k, 'en'));
  return words;
}

function bySense(a, b) {
  return a.level.localeCompare(b.level)
    || String(a.guide || '').localeCompare(String(b.guide || ''))
    || String(a.def || '').localeCompare(String(b.def || ''));
}

/* ------------------------------------------------------------------ *
 * 包描述
 * ------------------------------------------------------------------ */

export function buildManifest({ bytes, sha256, wordCount, senseCount }) {
  return {
    packId: PACK_ID,
    version: PACK_VERSION,
    schemaVersion: SCHEMA_VERSION,
    levels: LEVELS,
    file: `words.v${PACK_VERSION}.json`,
    wordCount,
    senseCount,
    bytes,
    sha256,
    generatedAt: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ *
 * 校验
 * ------------------------------------------------------------------ */

function makeChecker() {
  const results = [];
  return {
    expect(label, actual, want) {
      results.push({ label, actual, want, ok: String(actual) === String(want) });
    },
    get failed() {
      return results.filter(r => !r.ok).length;
    },
    print() {
      for (const r of results) {
        const tail = r.ok ? '' : `  (expected ${r.want})`;
        console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.label.padEnd(42)} ${r.actual}${tail}`);
      }
    },
  };
}

function validate({ db, payload, manifest, fileBytes, localAudio }) {
  const c = makeChecker();
  const words = payload.words;
  const allSenses = words.flatMap(w => w.senses);
  const rows = db.prepare('SELECT COUNT(*) n FROM evp_word').get().n;
  const byLevel = db.prepare('SELECT level, COUNT(*) n FROM evp_word GROUP BY level ORDER BY level').all();
  const senses = allSenses.length;
  const withEx = allSenses.filter(s => s.ex.length > 0).length;
  const refids = allSenses.map(s => s.refid);
  const audioSenses = allSenses.filter(s => s.a);
  const audioInPack = new Set(audioSenses.map(s => s.a));

  const allExamples = allSenses.flatMap(s => s.ex);
  const bracketLeft = allExamples.filter(s => s.indexOf('[') >= 0 || s.indexOf(']') >= 0).length;
  const dirty = allExamples.filter(s => s !== s.replace(/\s+/g, ' ').trim() || s.length === 0).length;

  c.expect('source rows', rows, EXPECT.rows);
  c.expect('levels', JSON.stringify(byLevel), JSON.stringify(Object.entries(EXPECT.byLevel).map(([level, n]) => ({ level, n }))));
  c.expect('words', words.length, EXPECT.words);
  c.expect('distinct wordKey', new Set(words.map(w => w.k)).size, EXPECT.words);
  c.expect('senses', senses, EXPECT.rows);
  c.expect('senses with examples', withEx, EXPECT.sensesWithExamples);
  c.expect('senses with audio', audioSenses.length, EXPECT.sensesWithAudio);
  c.expect('distinct audio in pack', audioInPack.size, EXPECT.distinctAudio);
  // a 只能是文件名，不能是 URL（音频靠 Service Worker 从同源抓）
  c.expect('audio name format', audioSenses.filter(s => !/^[a-z0-9_]+$/.test(s.a)).length, 0);
  c.expect('audio without local file', audioSenses.filter(s => !localAudio.has(s.a)).length, 0);
  c.expect('audio not in any sense', [...localAudio].filter(n => !audioInPack.has(n)).length, 0);
  c.expect('words with >=1 sense', words.filter(w => w.senses.length > 0).length, EXPECT.words);
  c.expect('level values', JSON.stringify([...new Set(allSenses.map(s => s.level))].sort()), JSON.stringify(LEVELS));
  c.expect('empty definition', allSenses.filter(s => !s.def).length, 0);
  c.expect('missing refid', refids.filter(r => !r).length, 0);
  c.expect('refid format', refids.filter(r => !isValidRefid(r)).length, 0);
  c.expect('missing headword', allSenses.filter(s => !s.hw).length, 0);
  c.expect('bracket residue in examples', bracketLeft, 0);
  c.expect('malformed example sentence', dirty, 0);
  // 派生 URL 不得回流到义项里 —— 义项只留 refid，链接由 baseUrl 拼
  c.expect('derived url in senses', allSenses.filter(s => 'url' in s).length, 0);
  c.expect('payload.baseUrl', payload.baseUrl, DETAIL_BASE);
  c.expect('manifest.wordCount', manifest.wordCount, words.length);
  c.expect('manifest.senseCount', manifest.senseCount, senses);
  c.expect('manifest.bytes', manifest.bytes, fileBytes.length);
  c.expect('manifest.sha256', manifest.sha256, createHash('sha256').update(fileBytes).digest('hex'));

  return c;
}

/** refid 形态：ID_00004106，以及 3 个义项级的 ID_00003010_520_UK */
function isValidRefid(r) {
  return typeof r === 'string' && (/^ID_\d{8}$/.test(r) || /^ID_\d{8}_\d{3}_UK$/.test(r));
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */

function main() {
  if (!existsSync(DB_PATH)) {
    console.error(`missing ${DB_PATH} -- run "npm run rebuild" first`);
    process.exit(1);
  }

  console.log('[1/3] reading', DB_PATH);
  const db = new DatabaseSync(DB_PATH);
  const rows = db.prepare('SELECT * FROM evp_word ORDER BY base_word').all();

  console.log('[2/3] cleaning and grouping...');
  const localAudio = audioFiles(AUDIO_DIR);
  // 官网自己也没有的 5 个音频名（共 7 行）→ 这些义项不写 a，前端回落 YouGlish
  let audioless = 0;
  for (const r of rows) {
    if (r.audio_name && !localAudio.has(r.audio_name)) {
      r.audio_name = null;
      audioless += 1;
    }
  }
  console.log(`       local audio: ${localAudio.size} files (${audioless} sense(s) have no file)`);

  const words = buildWords(rows);
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    packId: PACK_ID,
    version: PACK_VERSION,
    levels: LEVELS,
    wordCount: words.length,
    senseCount: words.reduce((n, w) => n + w.senses.length, 0),
    baseUrl: DETAIL_BASE,
    words,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  const wordsPath = join(OUT_DIR, `words.v${PACK_VERSION}.json`);
  const fileBytes = Buffer.from(JSON.stringify(payload), 'utf8');
  writeFileSync(wordsPath, fileBytes);

  const manifest = buildManifest({
    bytes: fileBytes.length,
    sha256: createHash('sha256').update(fileBytes).digest('hex'),
    wordCount: payload.wordCount,
    senseCount: payload.senseCount,
  });
  writeFileSync(join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  console.log('[3/3] validating...');
  const checker = validate({ db, payload, manifest, fileBytes, localAudio });
  checker.print();
  db.close();

  const senses = payload.senseCount;
  const exCount = words.reduce((n, w) => n + w.senses.reduce((m, s) => m + s.ex.length, 0), 0);
  const multi = words.filter(w => w.senses.length > 1).length;
  console.log('\n  file            :', wordsPath);
  console.log('  size            :', (fileBytes.length / 1024 / 1024).toFixed(2), 'MB',
    `(gzip ${Math.round(gzipSync(fileBytes, { level: 9 }).length / 1024)} KB)`);
  console.log('  words           :', words.length, ` (${multi} 个多义词)`);
  console.log('  senses / examples:', senses, '/', exCount);
  console.log('  senses with audio:', payload.words.flatMap(w => w.senses).filter(s => s.a).length,
    '/', senses, ` (${localAudio.size} mp3 files, ${(countAudioBytes(localAudio, AUDIO_DIR) / 1024 / 1024).toFixed(2)} MB)`);
  console.log('  zh placeholders :', words.filter(w => w.zh === null).length, '/ ready for S1.5');

  if (checker.failed > 0) {
    console.error(`\nFAILED: ${checker.failed} check(s)`);
    process.exit(2);
  }
  console.log('\nall checks passed');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main();
}
