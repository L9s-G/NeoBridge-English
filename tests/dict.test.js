/**
 * 字典查询的排序与匹配规则。真实词包只做轻量抽查（具体词名不写死），
 * 规则本身靠构造用例盯。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { searchWords } from '../app/js/core/dict.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const pack = JSON.parse(readFileSync(join(ROOT, 'app', 'data', 'words.v2.json'), 'utf8'));
const WORDS = pack.words;

const W = list => list.map(w => ({ w, senses: [] }));
const names = list => list.map(x => x.w);

test('空查询 / 无词 → 空结果，不炸', () => {
  assert.deepEqual(searchWords([], 'x'), []);
  assert.deepEqual(searchWords(null, 'x'), []);
  assert.deepEqual(searchWords(W(['a']), ''), []);
  assert.deepEqual(searchWords(W(['a']), '   '), []);
  assert.deepEqual(searchWords(W(['a']), null), []);
});

test('排序：完全相同 > 前缀 > 包含；同级词短优先', () => {
  const words = W(['platform', 'aform', 'formal', 'form', 'FORMAT']);
  // rank0 精确：form；rank1 前缀：formal(6)、FORMAT→format(6) 同长按字母序；
  // rank2 包含：aform(5) < platform(8)
  assert.deepEqual(
    names(searchWords(words, 'form')),
    ['form', 'formal', 'FORMAT', 'aform', 'platform'],
  );
});

test('包含匹配排在所有前缀之后', () => {
  const words = W(['platform', 'formal', 'zformz', 'form']);
  assert.deepEqual(names(searchWords(words, 'form')), ['form', 'formal', 'zformz', 'platform']);
});

test('大小写不敏感 + 首尾空白 + 内部空白折叠', () => {
  const words = W(['Take Off', 'ability']);
  assert.deepEqual(names(searchWords(words, '  TAKE   off ')), ['Take Off']);
  assert.deepEqual(names(searchWords(words, 'ABILITY')), ['ability']);
});

test('短语卡：前缀与包含都能命中', () => {
  const words = W(['take off', 'take', 'mistake']);
  assert.deepEqual(names(searchWords(words, 'take')), ['take', 'take off', 'mistake']);
  assert.deepEqual(names(searchWords(words, 'off')), ['take off']);
});

test('无命中 → []', () => {
  assert.deepEqual(searchWords(W(['a', 'b']), 'zzz'), []);
});

test('返回原始词对象（引用不变），真实词包抽查', () => {
  const hit = searchWords(WORDS, 'ability');
  assert.ok(hit.length >= 1);
  assert.equal(hit[0].w, 'ability', '精确匹配排第一');
  assert.equal(hit[0], WORDS.find(x => x.w === 'ability'), '是词包里的同一个对象');

  const phrase = searchWords(WORDS, 'take off');
  assert.equal(phrase[0].w, 'take off', '短语精确匹配排第一');

  const prefix = searchWords(WORDS, 'abili');
  assert.ok(prefix.every(x => /abili/i.test(x.w)), '结果全部含查询串');

  assert.equal(WORDS.length, 5008, '全量 5008 含短语');
});
