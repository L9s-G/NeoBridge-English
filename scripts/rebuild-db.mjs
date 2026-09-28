#!/usr/bin/env node
/**
 * Rebuild data/evp.sqlite from data/raw/checkpoint.json -- no network, no
 * browser. Use after the schema changes in scripts/evp-lib.mjs, or whenever
 * the database needs regenerating without re-harvesting.
 *
 * Usage:
 *   npm run rebuild
 *   node scripts/rebuild-db.mjs
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { EXPECTED_TOTAL, LEVELS, buildRows, canonicalAudioName, loadAudioMap, sortRows, writeDb, report } from './evp-lib.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CHECKPOINT = join(ROOT, 'data', 'raw', 'checkpoint.json');
const AUDIO_FILES = join(ROOT, 'data', 'raw', 'audio-files.json');
const DB_PATH = join(ROOT, 'data', 'evp.sqlite');

if (!existsSync(CHECKPOINT)) {
  console.error(`missing ${CHECKPOINT} -- run "npm run scrape" first`);
  process.exit(1);
}

const cp = JSON.parse(readFileSync(CHECKPOINT, 'utf8'));
if (!Array.isArray(cp.records)) {
  console.error('checkpoint has no records[] -- run "npm run scrape" first');
  process.exit(1);
}

const records = new Map();
for (const r of cp.records) records.set(r._id, r);
const lookups = new Map(cp.lookups || []);

console.log(`[1/3] checkpoint: ${records.size} records (page ${cp.page}, saved ${cp.savedAt})`);

const audio = loadAudioMap(AUDIO_FILES);
console.log(`       audio files : ${audio.size} urls${audio.size ? '' : '  (missing audio-files.json — run "npm run scrape:audio")'}`);

const { rows, offFilter } = buildRows(records, lookups);
sortRows(rows);
const entries = writeDb(rows, DB_PATH, { audio });
const clean = report(rows, offFilter, audio);

console.log('[2/3] validating...');

const db = new DatabaseSync(DB_PATH);
const one = sql => db.prepare(sql).get();
const all = sql => db.prepare(sql).all();

const checks = [];
const expect = (label, actual, want) => checks.push({
  label,
  actual,
  want,
  ok: String(actual) === String(want),
});

expect('rows', one('SELECT COUNT(*) n FROM evp_word').n, EXPECTED_TOTAL);
expect('levels', JSON.stringify(all('SELECT level, COUNT(*) n FROM evp_word GROUP BY level ORDER BY level')),
  JSON.stringify(LEVELS.map(l => ({ level: l, n: l === 'B1' ? 2937 : 4164 }))));
expect('distinct base_word', one('SELECT COUNT(DISTINCT base_word) n FROM evp_word').n, 5008);
expect('distinct headword', one('SELECT COUNT(DISTINCT headword) n FROM evp_word').n, 3859);
expect('distinct refid', one('SELECT COUNT(DISTINCT refid) n FROM evp_word').n, 3865);
expect('distinct entry_refid', one('SELECT COUNT(DISTINCT entry_refid) n FROM evp_word').n, 3862);
expect('evp_entry rows', one('SELECT COUNT(*) n FROM evp_entry').n, 3862);
expect('multi-member entries', one('SELECT COUNT(*) n FROM evp_entry WHERE member_count > 1').n, 591);
expect('sense-level refids (refid <> entry_refid)', one('SELECT COUNT(*) n FROM evp_word WHERE refid <> entry_refid').n, 3);
expect('null headword', one('SELECT COUNT(*) n FROM evp_word WHERE headword IS NULL').n, 0);
expect('orphan entry_refid', one(`SELECT COUNT(*) n FROM evp_word w
  WHERE w.entry_refid IS NOT NULL AND NOT EXISTS (SELECT 1 FROM evp_entry e WHERE e.refid = w.entry_refid)`).n, 0);
expect('orphan details_url', one('SELECT COUNT(*) n FROM evp_word WHERE details_url IS NULL').n, 0);
expect('entry headword mismatch', one(`SELECT COUNT(*) n FROM evp_entry e
  WHERE e.headword <> (SELECT w.headword FROM evp_word w WHERE w.entry_refid = e.refid LIMIT 1)`).n, 0);
// audio_name 非空 ⇔ 官网音频表里查得到 URL（查不到的 7 行已按 null 存）
expect('audio_name filled', one('SELECT COUNT(*) n FROM evp_word WHERE audio_name IS NOT NULL').n, 5455);
expect('distinct audio_name', one('SELECT COUNT(DISTINCT audio_name) n FROM evp_word WHERE audio_name IS NOT NULL').n, 3701);
if (audio.size) {
  expect('evp_audio rows', one('SELECT COUNT(*) n FROM evp_audio').n, 13229);
  expect('audio_name without url', one(`SELECT COUNT(*) n FROM evp_word w
    WHERE w.audio_name IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM evp_audio a WHERE a.name = w.audio_name)`).n, 0);
  // 官网缺失那 5 个名字不会因此消失：从 checkpoint 记账，异常照样看得见
  const claimed = cp.records
    .map(r => r.audiofilename_text)
    .filter(Boolean)
    .map(canonicalAudioName);
  const dead = claimed.filter(n => !audio.has(n));
  expect('官网声称但音频表没有 (文件名)', new Set(dead).size, 5);
  expect('官网声称但音频表没有 (义项行)', dead.length, 7);
} else {
  console.log('  skip evp_audio checks — no data/raw/audio-files.json');
}

let failed = 0;
for (const c of checks) {
  if (!c.ok) failed += 1;
  console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.label.padEnd(42)} ${c.actual}${c.ok ? '' : `  (expected ${c.want})`}`);
}

console.log('[3/3] entry table sample:');
for (const e of all('SELECT refid, headword, member_count, sense_count, levels FROM evp_entry ORDER BY member_count DESC, refid LIMIT 5')) {
  console.log(`  ${e.refid}  hw="${e.headword}"  members=${e.member_count}  senses=${e.sense_count}  ${e.levels}`);
}
const joined = one(`SELECT e.member_count, e.member_words FROM evp_entry e WHERE e.refid = 'ID_00000045'`);
console.log(`  ID_00000045 members:\n    ${joined.member_words.split('\n').join('\n    ')}`);

db.close();

console.log(`\nSQLite written: ${DB_PATH}`);
if (failed > 0 || !clean) {
  console.error(`\nFAILED: ${failed} check(s) did not match`);
  process.exit(2);
}
console.log('all checks passed');
