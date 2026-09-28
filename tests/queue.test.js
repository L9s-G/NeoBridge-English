import assert from 'node:assert/strict';
import { test } from 'node:test';

import { withParams } from '../app/js/core/params.js';
import { SIGNAL } from '../app/js/core/mastery.js';
import { createState } from '../app/js/core/progress.js';
import { buildQueue } from '../app/js/core/queue.js';

import { mulberry32 } from './_rng.js';

const params = withParams();
const word = (k, levels = ['B1']) => ({ k, w: k, levels });
const wordsOf = n => Array.from({ length: n }, (_, i) => word(`w${i}`));

test('空输入返回空队列', () => {
  const rng = mulberry32(1);
  assert.deepEqual(buildQueue({ words: [], states: {}, params, size: 10, rng }), []);
  assert.deepEqual(buildQueue({ words: null, states: {}, params, size: 10, rng }), []);
  assert.deepEqual(buildQueue({ words: wordsOf(5), states: {}, params, size: 0, rng }), []);
});

test('题数等于 size，且一轮内不重复', () => {
  const words = wordsOf(50);
  const queue = buildQueue({ words, states: {}, params, size: 20, rng: mulberry32(42) });

  assert.equal(queue.length, 20);
  assert.equal(new Set(queue.map(q => q.k)).size, 20, '一轮内没有重复的词');
  const keys = new Set(words.map(w => w.k));
  for (const item of queue) assert.ok(keys.has(item.k), `${item.k} 应在候选里`);
});

test('候选词抽完就提前收工', () => {
  const queue = buildQueue({ words: wordsOf(7), states: {}, params, size: 100, rng: mulberry32(7) });
  assert.equal(queue.length, 7);
});

test('pool 字段与分池规则一致', () => {
  const words = [word('a'), word('b'), word('c')];
  const states = {
    a: createState(0),                                                  // 未作答 → new
    b: { ...createState(0), lastResult: SIGNAL.WRONG },                 // 答错 → err
    c: { ...createState(0), lastResult: SIGNAL.RIGHT, mastery: 0.9 },   // 已掌握 → rev
  };

  const queue = buildQueue({ words, states, params, size: 3, rng: mulberry32(3) });
  const byKey = Object.fromEntries(queue.map(q => [q.k, q.pool]));
  assert.deepEqual(byKey, { a: 'new', b: 'err', c: 'rev' });
});

test('同一随机种子结果确定', () => {
  const words = wordsOf(40);
  const build = seed => buildQueue({ words, states: {}, params, size: 15, rng: mulberry32(seed) });

  assert.deepEqual(build(99), build(99));
  assert.notDeepEqual(build(99), build(100));
});

test('候选子集只出子集里的词（重练错词）', () => {
  const words = wordsOf(30);
  const wrong = words.slice(10, 15);

  const queue = buildQueue({ words: wrong, states: {}, params, size: 10, rng: mulberry32(5) });
  const subset = new Set(wrong.map(w => w.k));

  assert.equal(queue.length, wrong.length, 'size 大于候选数时出完为止');
  for (const item of queue) assert.ok(subset.has(item.k), `${item.k} 不该出现`);
});
