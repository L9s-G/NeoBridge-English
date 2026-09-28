/**
 * 发音相关的纯逻辑校验 —— 不碰 Cache Storage / Audio，直接跑真实的 app/data/ 与 app/audio/。
 * 与 importer.test.js 同一思路：构造用例验规则，真实词包验覆盖。
 *
 * ⚠ 写死的 3701 / 5455 依赖当前词包 + app/audio/ 里的文件，换包后先看数据再改数字。
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  audioNamesOf,
  audioNamesOfWord,
  audioUrl,
} from '../app/js/ui/audio-download.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA = join(ROOT, 'app', 'data');
const AUDIO_DIR = join(ROOT, 'app', 'audio');

const manifest = JSON.parse(readFileSync(join(DATA, 'manifest.json'), 'utf8'));
const pack = JSON.parse(readFileSync(join(DATA, manifest.file), 'utf8'));
const onDisk = new Set(
  readdirSync(AUDIO_DIR).filter(f => f.endsWith('.mp3')).map(f => f.slice(0, -4)),
);

test('audioNamesOf：词包里的发音就是磁盘上那 3701 个，一个不多一个不少', () => {
  const names = audioNamesOf(pack);
  assert.equal(names.length, 3701);
  assert.deepEqual(new Set(names), onDisk);
  assert.deepEqual(names, [...names].sort(), '清单应已排序');
});

test('词包里每个 a 都有本地文件', () => {
  const senses = pack.words.flatMap(w => w.senses);
  const withAudio = senses.filter(s => s.a);
  assert.equal(withAudio.length, 5455);
  assert.equal(withAudio.filter(s => !onDisk.has(s.a)).length, 0);
});

test('a 只能是文件名，不能是 URL', () => {
  const bad = pack.words
    .flatMap(w => w.senses)
    .filter(s => s.a && !/^[a-z0-9_]+$/.test(s.a));
  assert.equal(bad.length, 0);
});

test('audioUrl：同源相对路径 + .mp3', () => {
  assert.equal(audioUrl('ukacces028'), './audio/ukacces028.mp3');
});

test('audioNamesOfWord：去重保序，没发音返回空数组', () => {
  assert.deepEqual(
    audioNamesOfWord({ senses: [{ a: 'b' }, { a: null }, { a: 'b' }, { a: 'a' }] }),
    ['b', 'a'],
  );
  assert.deepEqual(audioNamesOfWord({ senses: [{}, { a: null }] }), []);
  assert.deepEqual(audioNamesOfWord(null), []);
});

// 官网声称有音频、音频表里却查不到 URL 的 5 个名（drown/hand-held/infinitive/junior/produce，
// 共 7 行义项）—— DB 与词包都存 null，卡片回落 YouGlish 外链。
test('官网缺失音频的 5 个词：a 全为 null，喇叭走 YouGlish', () => {
  const dead = ['drown', 'hand-held', 'infinitive', 'junior', 'produce'];
  const words = pack.words.filter(w => dead.includes(w.w));
  assert.equal(words.length, 5);
  for (const w of words) {
    assert.equal(w.senses.filter(s => s.a).length, 0, `${w.w} 不该有本地发音`);
    assert.ok(w.senses.every(s => s.a === null), `${w.w} 的 a 应显式为 null`);
    assert.deepEqual(audioNamesOfWord(w), [], `${w.w} 应回落 YouGlish`);
  }
});
