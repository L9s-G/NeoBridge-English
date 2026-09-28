/**
 * 三池划分与配额。
 *
 * 一个词只会落在 新词 / 错词 / 巩固 之一，抽到哪一池由配额决定，
 * 配额随 coverage（新词完成度）线性变化。
 *
 * "最近答错"不进权重公式 —— 它通过 mastery 下降 + 进入错词池两条路生效，
 * 错词出现的频率完全由这里的配额控制，避免两套规则打架。
 */

import { SIGNAL } from './mastery.js';

export const POOL = Object.freeze({ NEW: 'new', ERR: 'err', REV: 'rev' });
/** 顺序即抽池时的遍历顺序，改动会同时影响 scheduler.js 的取整边界 */
export const POOLS = [POOL.NEW, POOL.ERR, POOL.REV];

/**
 * 归属的池。从未作答 → 新词池
 *
 * 判错有三条，满足任一即进错词池（越靠前越"硬"）：
 *   1. 最近一次就答错了
 *   2. 错过一次、但还没连续答对 recoverStreak 次 —— **错词名单用同一条**
 *   3. 从没错过，但掌握度低于 errPoolThreshold（当错词一样多练）
 */
export function poolOf(state, params) {
  if (!state || state.lastResult == null) return POOL.NEW;
  if (state.lastResult === SIGNAL.WRONG) return POOL.ERR;
  if (isWrongWord(state, params)) return POOL.ERR;
  if ((state.mastery ?? 0) < params.errPoolThreshold) return POOL.ERR;
  return POOL.REV;
}

/**
 * 还在错词名单里：错过至少一次，且连续答对不足 recoverStreak 次。
 * 错词列表与错词池共用这一条，保证"列表里有的词，调度上也当错词练"。
 */
export function isWrongWord(state, params) {
  if (!state || (state.wrongs || 0) <= 0) return false;
  return (state.rightStreak || 0) < params.recoverStreak;
}

const lerp = (a, b, t) => a + (b - a) * t;

/** coverage ∈ [0,1] → 三池配额，两端值取自 params.quotas */
export function quotasFor(coverage, params) {
  const t = coverage <= 0 ? 0 : coverage >= 1 ? 1 : coverage;
  const { start, end } = params.quotas;
  return {
    new: lerp(start.new, end.new, t),
    err: lerp(start.err, end.err, t),
    rev: lerp(start.rev, end.rev, t),
  };
}

/**
 * 只保留仍然有词的池，并把它们的份额重新归一化（总和恒为 1）。
 * 例如开卷时错词池还空着，它的 10% 会按比例摊给新词池和巩固池。
 */
export function normalizeQuotas(quotas, available) {
  const out = { new: 0, err: 0, rev: 0 };
  if (!available.length) return out;

  let total = 0;
  for (const p of available) total += quotas[p] || 0;

  if (total <= 0) {
    const even = 1 / available.length;
    for (const p of available) out[p] = even;
    return out;
  }
  for (const p of available) out[p] = (quotas[p] || 0) / total;
  return out;
}
