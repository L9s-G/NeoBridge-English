/**
 * 用真实的 5008 词词包跑一段模拟，验证调度器的宏观行为：
 * 配额是否真的被遵守、coverage 上升时错词池份额是否真的变大、
 * session 内是否真的零重复。
 *
 * 随机数用固定种子，结论可复现。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { withParams } from '../app/js/core/params.js';
import { SIGNAL, applyAnswer } from '../app/js/core/mastery.js';
import { POOLS } from '../app/js/core/pools.js';
import { coverageOf, createState, markSeen } from '../app/js/core/progress.js';
import { pickNext } from '../app/js/core/scheduler.js';

import { mulberry32 } from './_rng.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA = join(ROOT, 'app', 'data');
const manifest = JSON.parse(readFileSync(join(DATA, 'manifest.json'), 'utf8'));
const pack = JSON.parse(readFileSync(join(DATA, manifest.file), 'utf8'));

const PICKS = 8000;
const SESSION = 100;
const BUCKETS = 10;

test('5008 词 × 8000 次抽样：配额、趋势、session 去重', () => {
  const params = withParams();
  const rng = mulberry32(42);
  const states = {};
  const sessionSeen = new Set();

  const buckets = Array.from({ length: BUCKETS }, () => ({
    n: 0, new: 0, err: 0, rev: 0, expNew: 0, expErr: 0, expRev: 0,
  }));

  let coverage = 0;
  for (let i = 0; i < PICKS; i++) {
    if (i % SESSION === 0) sessionSeen.clear();

    coverage = coverageOf(states, pack.words);
    const r = pickNext({ words: pack.words, states, params, coverage, sessionSeen, rng });
    assert.ok(r, `第 ${i + 1} 次应能出词`);

    assert.ok(!sessionSeen.has(r.word.k), `session 内重复出词：${r.word.k}`);
    sessionSeen.add(r.word.k);

    const b = buckets[Math.min(BUCKETS - 1, Math.floor(coverage * BUCKETS))];
    b.n++;
    b[r.pool]++;
    b.expNew += r.probs.new;
    b.expErr += r.probs.err;
    b.expRev += r.probs.rev;

    // 简单的作答模型：掌握度越高越容易答对
    const seen = markSeen(states[r.word.k], i);
    const signal = rng() < 0.5 + 0.45 * seen.mastery ? SIGNAL.RIGHT : SIGNAL.WRONG;
    states[r.word.k] = applyAnswer(seen, signal, i, params);
  }

  assert.ok(coverage > 0.5, `coverage 应过半，实际 ${coverage.toFixed(3)}`);

  // 1) 抽样命中率要贴合当时声明的配额
  const solid = buckets.filter(b => b.n >= 200);
  assert.ok(solid.length >= 6, `有效分桶不足，实际 ${solid.length}`);
  for (const b of solid) {
    for (const p of POOLS) {
      const obs = b[p] / b.n;
      const exp = (p === 'new' ? b.expNew : p === 'err' ? b.expErr : b.expRev) / b.n;
      assert.ok(
        Math.abs(obs - exp) < 0.06,
        `coverage 分桶 [${b.n} 样本] ${p} 命中率 ${obs.toFixed(3)} 偏离配额 ${exp.toFixed(3)}`,
      );
    }
  }

  // 2) 新词完成度越高，错词池份额越大、新词池份额越小
  const first = solid[0];
  const last = solid[solid.length - 1];
  const errShare = b => b.err / b.n;
  const newShare = b => b.new / b.n;
  assert.ok(
    errShare(last) > errShare(first),
    `错词池份额应随 coverage 上升：${errShare(first).toFixed(3)} → ${errShare(last).toFixed(3)}`,
  );
  assert.ok(
    newShare(last) < newShare(first),
    `新词池份额应随 coverage 下降：${newShare(first).toFixed(3)} → ${newShare(last).toFixed(3)}`,
  );
});
