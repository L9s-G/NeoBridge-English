import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SIGNAL, applyAnswer } from '../app/js/core/mastery.js';
import { coverageOf, createState, markSeen } from '../app/js/core/progress.js';
import { isWrongWord, normalizeQuotas, POOLS, poolOf, quotasFor } from '../app/js/core/pools.js';
import { withParams } from '../app/js/core/params.js';
import { pickNext, poolProbabilities } from '../app/js/core/scheduler.js';
import { topLevel, wordWeight } from '../app/js/core/weight.js';

import { mulberry32 } from './_rng.js';

const params = withParams();
const word = (k, levels = ['B1']) => ({ k, w: k, levels });
const approx = (a, b, tol, label = '') =>
  assert.ok(Math.abs(a - b) <= tol, `${label} ${a} 应约等于 ${b}（容差 ${tol}）`);

/* ---------------- 配额 ---------------- */

test('配额从 coverage=0 线性走到 coverage=1', () => {
  assert.deepEqual(quotasFor(0, params), { new: 0.75, err: 0.1, rev: 0.15 });
  assert.deepEqual(quotasFor(1, params), { new: 0.3, err: 0.4, rev: 0.3 });
  approx(quotasFor(0.5, params).new, 0.525, 1e-12, 'mid new');
  approx(quotasFor(0.5, params).err, 0.25, 1e-12, 'mid err');
  approx(quotasFor(0.5, params).rev, 0.225, 1e-12, 'mid rev');
});

test('coverage 超出 [0,1] 时按端点截断', () => {
  assert.deepEqual(quotasFor(-3, params), quotasFor(0, params));
  assert.deepEqual(quotasFor(9, params), quotasFor(1, params));
});

test('三个配额之和恒为 1', () => {
  for (const c of [0, 0.1, 0.33, 0.5, 0.77, 1]) {
    const q = quotasFor(c, params);
    approx(q.new + q.err + q.rev, 1, 1e-12, `coverage=${c}`);
  }
});

test('空池份额按比例重新分配，且总和仍为 1', () => {
  const q = { new: 0.75, err: 0.1, rev: 0.15 };

  const two = normalizeQuotas(q, ['new', 'rev']);
  assert.equal(two.err, 0);
  approx(two.new, 0.75 / 0.9, 1e-12, 'new');
  approx(two.rev, 0.15 / 0.9, 1e-12, 'rev');
  approx(two.new + two.err + two.rev, 1, 1e-12);

  assert.deepEqual(normalizeQuotas(q, []), { new: 0, err: 0, rev: 0 });
  assert.deepEqual(normalizeQuotas({ new: 0, err: 0, rev: 0 }, ['err', 'rev']), { new: 0, err: 0.5, rev: 0.5 });
});

/* ---------------- 分池 ---------------- */

test('分池规则', () => {
  assert.equal(poolOf(undefined, params), 'new');                       // 从没见过
  assert.equal(poolOf(createState(0), params), 'new');                  // 见过但没作答
  assert.equal(poolOf({ mastery: 0.2, lastResult: SIGNAL.RIGHT }, params), 'err');   // 答对了但掌握低
  assert.equal(poolOf({ mastery: 0.9, lastResult: SIGNAL.WRONG }, params), 'err');   // 最近答错
  assert.equal(poolOf({ mastery: 0.6, lastResult: SIGNAL.RIGHT }, params), 'rev');
});

test('池顺序固定为 new / err / rev', () => {
  assert.deepEqual(POOLS, ['new', 'err', 'rev']);
});

/* ---------------- 错词名单 ---------------- */

test('错过一次、连对 recoverStreak 次才算恢复', () => {
  const P = withParams({ recoverStreak: 2 });
  const right = { ...createState(0), lastResult: SIGNAL.RIGHT };

  // 纯答对（从没错过）不算错词
  assert.equal(isWrongWord(right, P), false);

  const missed = { ...createState(0), wrongs: 1, lastWrongAt: 100, lastResult: SIGNAL.RIGHT };
  assert.equal(isWrongWord(missed, P), true, '错一次就进名单');

  assert.equal(isWrongWord({ ...missed, rightStreak: 1 }, P), true, '只连对 1 次，还没恢复');
  assert.equal(isWrongWord({ ...missed, rightStreak: 2 }, P), false, '连对 2 次，恢复');

  const twice = { ...missed, wrongs: 3, rightStreak: 2 };
  assert.equal(isWrongWord(twice, P), false, '错 3 次也一样，只看连续正确次数');
});

test('recoverStreak 可调', () => {
  const state = { ...createState(0), wrongs: 1, rightStreak: 2, lastResult: SIGNAL.RIGHT };
  assert.equal(isWrongWord(state, withParams({ recoverStreak: 2 })), false);
  assert.equal(isWrongWord(state, withParams({ recoverStreak: 3 })), true);
});

test('错词池与错词名单用同一条规则', () => {
  const P = withParams();
  const notYet = { ...createState(0), wrongs: 1, rightStreak: 1, mastery: 0.8, lastResult: SIGNAL.RIGHT };
  const recovered = { ...notYet, rightStreak: 2 };

  assert.equal(isWrongWord(notYet, P), true);
  assert.equal(poolOf(notYet, P), 'err', '名单里有，池里也得是 err');

  assert.equal(isWrongWord(recovered, P), false);
  assert.equal(poolOf(recovered, P), 'rev', '名单里没了，且掌握度够 → 巩固池');
});

/* ---------------- 权重 ---------------- */

test('topLevel 取最高等级', () => {
  assert.equal(topLevel(['B1', 'B2']), 'B2');
  assert.equal(topLevel(['B1']), 'B1');
  assert.equal(topLevel([]), null);
  assert.equal(topLevel(null), null);
});

test('权重随 level / mastery / timesSeen 单调变化', () => {
  const b2 = word('b2', ['B1', 'B2']);
  const b1 = word('b1', ['B1']);

  assert.ok(wordWeight(b2, null, params) > wordWeight(b1, null, params), 'B2 应高于 B1');

  const fresh = createState(0);
  const mastered = { ...fresh, mastery: 0.9 };
  assert.ok(wordWeight(b1, fresh, params) > wordWeight(b1, mastered, params), '掌握度越高权重越低');

  const seen = { ...fresh, timesSeen: 20 };
  assert.ok(wordWeight(b1, fresh, params) > wordWeight(b1, seen, params), '见得越多权重越低');
  assert.equal(wordWeight(b1, undefined, params), wordWeight(b1, fresh, params), '无状态视为全新');
});

/* ---------------- 进度 ---------------- */

test('createState 初始值', () => {
  const s = createState(42);
  assert.equal(s.mastery, 0);
  assert.equal(s.lastResult, null);
  assert.equal(s.timesSeen, 0);
  assert.equal(s.wrongStreak, 0);
  assert.equal(s.firstSeenAt, 42);
});

test('wordKey 从创建一直带到更新（progress 仓库的 keyPath）', () => {
  const s = createState(42, 'account');
  assert.equal(s.k, 'account');
  assert.equal(markSeen(s, 43).k, 'account');
  assert.equal(applyAnswer(markSeen(s, 43), SIGNAL.WRONG, 44, params).k, 'account');
  assert.equal(s.k, 'account', '原对象不被修改');
});

test('markSeen 累计次数且不修改原对象', () => {
  const a = createState(1);
  const b = markSeen(a, 2);
  assert.equal(a.timesSeen, 0);
  assert.equal(b.timesSeen, 1);
  assert.equal(b.lastSeenAt, 2);
  assert.equal(b.firstSeenAt, 1);
  assert.equal(markSeen(undefined, 3).timesSeen, 1, '无状态时自动创建');
});

test('coverage = 本包已作答词数 / 本包词数', () => {
  const words = Array.from({ length: 4 }, (_, i) => ({ k: `w${i}` }));
  const states = {};
  assert.equal(coverageOf(states, words), 0);
  assert.equal(coverageOf(states, []), 0);

  states.w0 = { ...createState(0), lastResult: SIGNAL.RIGHT };
  states.w1 = createState(0);                                   // 见过但没作答，不计入
  states.w2 = { ...createState(0), lastResult: SIGNAL.WRONG };
  states.other_pack_word = { ...createState(0), lastResult: SIGNAL.RIGHT };  // 别的包的词，不计入
  approx(coverageOf(states, words), 0.5, 1e-12);

  const done = words.map(w => ({ ...w, k: w.k }));
  for (const w of done) states[w.k] = { ...createState(0), lastResult: SIGNAL.RIGHT };
  assert.equal(coverageOf(states, words), 1, '全部作答时为 1');
});

/* ---------------- 作答更新 ---------------- */

test('四种信号的 mastery 变化', () => {
  const fromZero = sig => applyAnswer(createState(0), sig, 1, params).mastery;

  approx(fromZero(SIGNAL.RIGHT), 0.18, 1e-12, 'right');
  approx(fromZero(SIGNAL.EXAM_RIGHT), 0.3, 1e-12, 'examRight');
  assert.ok(fromZero(SIGNAL.EXAM_RIGHT) > fromZero(SIGNAL.RIGHT), '主动回忆增益更高');

  const mid = { ...createState(0), mastery: 0.5 };
  approx(applyAnswer(mid, SIGNAL.WRONG, 1, params).mastery, 0.225, 1e-12, 'wrong');
  approx(applyAnswer(mid, SIGNAL.FUZZY, 1, params).mastery, 0.375, 1e-12, 'fuzzy');

  let s = createState(0);
  for (let i = 0; i < 100; i++) s = applyAnswer(s, SIGNAL.RIGHT, i, params);
  assert.ok(s.mastery <= 1 && s.mastery > 0.99, '反复答对收敛到 1 且不越界');
});

test('wrongs / rightStreak / lastWrongAt 的累计与清零', () => {
  let s = createState(0);

  s = applyAnswer(s, SIGNAL.WRONG, 10, params);
  assert.equal(s.wrongs, 1);
  assert.equal(s.rightStreak, 0);
  assert.equal(s.lastWrongAt, 10);

  s = applyAnswer(s, SIGNAL.RIGHT, 20, params);
  assert.equal(s.wrongs, 1, '答对不清零累计错次');
  assert.equal(s.rightStreak, 1);

  s = applyAnswer(s, SIGNAL.FUZZY, 30, params);
  assert.equal(s.rightStreak, 0, '模糊不算正确，中断连对');
  assert.equal(s.wrongs, 1, '模糊不算错');

  s = applyAnswer(s, SIGNAL.RIGHT, 40, params);
  assert.equal(s.rightStreak, 1);

  s = applyAnswer(s, SIGNAL.WRONG, 50, params);
  assert.equal(s.wrongs, 2);
  assert.equal(s.rightStreak, 0);
  assert.equal(s.lastWrongAt, 50, '每次答错都刷新 lastWrongAt');
});

test('连续错误只在答对时清零，模糊不动它', () => {  let s = createState(0);
  const step = sig => { s = applyAnswer(s, sig, 1, params); return s.wrongStreak; };

  assert.equal(step(SIGNAL.WRONG), 1);
  assert.equal(step(SIGNAL.WRONG), 2);
  assert.equal(step(SIGNAL.FUZZY), 2, '模糊不算错也不算对');
  assert.equal(step(SIGNAL.WRONG), 3);
  assert.equal(step(SIGNAL.EXAM_RIGHT), 0);
});

test('未知信号直接抛错', () => {
  assert.throws(() => applyAnswer(createState(0), 'nope', 1, params), /unknown signal/);
});

/* ---------------- 抽样 ---------------- */

test('session 内不重复出词', () => {
  const words = Array.from({ length: 600 }, (_, i) => word(`w${i}`));
  const sessionSeen = new Set();
  const rng = mulberry32(11);
  const picked = [];

  for (let i = 0; i < 500; i++) {
    const r = pickNext({ words, states: {}, params, coverage: 0, sessionSeen, rng });
    assert.ok(r, `第 ${i + 1} 次应能出词`);
    assert.ok(!sessionSeen.has(r.word.k), '不得重复出词');
    sessionSeen.add(r.word.k);
    picked.push(r.word.k);
  }
  assert.equal(new Set(picked).size, 500);
});

test('session 内词用尽时返回 null', () => {
  const words = [word('a'), word('b'), word('c')];
  const r = pickNext({
    words, states: {}, params, coverage: 0,
    sessionSeen: new Set(['a', 'b', 'c']),
    rng: mulberry32(1),
  });
  assert.equal(r, null);
});

test('只有新词池时，配额归一化到 new = 1', () => {
  const words = [word('a'), word('b')];
  const { probs } = poolProbabilities({
    words, states: {}, params, coverage: 0, sessionSeen: new Set(),
  });
  assert.equal(probs.err, 0);
  assert.equal(probs.rev, 0);
  assert.equal(probs.new, 1);
});

test('命中率与配额吻合（20000 次抽样）', () => {
  const words = Array.from({ length: 600 }, (_, i) => word(`w${i}`, i % 2 ? ['B1'] : ['B2']));

  // 造出三池都有词的状态：300 未作答、150 答对但掌握低、150 巩固
  const states = {};
  words.forEach((w, i) => {
    if (i < 300) return;
    states[w.k] = { ...createState(0), lastResult: SIGNAL.RIGHT, mastery: i < 450 ? 0.2 : 0.7 };
  });

  const coverage = coverageOf(states, words);
  const { probs } = poolProbabilities({ words, states, params, coverage, sessionSeen: new Set() });
  assert.deepEqual(POOLS.filter(p => probs[p] > 0), ['new', 'err', 'rev'], '三池都应有份额');

  const rng = mulberry32(7);
  const got = { new: 0, err: 0, rev: 0 };
  const N = 20000;
  for (let i = 0; i < N; i++) {
    const r = pickNext({ words, states, params, coverage, sessionSeen: new Set(), rng });
    got[r.pool]++;
  }

  for (const p of POOLS) approx(got[p] / N, probs[p], 0.02, `${p} 命中率`);
});
