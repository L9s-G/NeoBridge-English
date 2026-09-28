/**
 * 抽一个词的完整流程：
 *
 *   1. 排除本次 session 已出现过的词（session 级去重，替代分钟级冷却）
 *   2. 按 poolOf 分到 新词 / 错词 / 巩固 三池
 *   3. 按 coverage 取配额，空池的份额重新分配
 *   4. 池内按 wordWeight 加权随机
 *
 * 全程无 IO：words / states / coverage / sessionSeen 由调用方提供，
 * 随机数 rng 与参数 params 均可注入，便于测试断言。
 */

import { normalizeQuotas, poolOf, POOLS, quotasFor } from './pools.js';
import { wordWeight } from './weight.js';

/** 把候选词分进三个池；sessionSeen 里的词直接跳过 */
export function buildPools({ words, states, params, sessionSeen }) {
  const pools = { new: [], err: [], rev: [] };
  for (const word of words) {
    if (sessionSeen && sessionSeen.has(word.k)) continue;
    pools[poolOf(states[word.k], params)].push(word);
  }
  return pools;
}

export function availablePools(pools) {
  return POOLS.filter(p => pools[p].length > 0);
}

/**
 * 本次抽样的概率分布。
 * 返回 null 表示所有词都已出过，本次 session 没得抽了。
 */
export function poolProbabilities({ words, states, params, coverage, sessionSeen }) {
  const pools = buildPools({ words, states, params, sessionSeen });
  const available = availablePools(pools);
  if (!available.length) return { pools, probs: null };
  return { pools, probs: normalizeQuotas(quotasFor(coverage, params), available) };
}

/** 池内加权随机：权重全为 0（极端情况）时退化为等概率 */
function pickWeighted(pool, states, params, rng) {
  const weights = pool.map(w => wordWeight(w, states[w.k], params));
  const total = weights.reduce((a, b) => a + b, 0);

  if (!(total > 0)) return pool[Math.floor(rng() * pool.length)];

  let r = rng() * total;
  for (let i = 0; i < pool.length; i++) {
    r -= weights[i];
    if (r <= 0) return pool[i];
  }
  return pool[pool.length - 1];
}

/**
 * 抽一个词。返回 { word, pool, probs } 或 null。
 * pool 与 probs 一并返回，UI 可以显示"新词/错词"角标，
 * 测试也用它核对命中率与配额是否吻合。
 */
export function pickNext({ words, states, params, coverage, sessionSeen, rng = Math.random }) {
  const { pools, probs } = poolProbabilities({ words, states, params, coverage, sessionSeen });
  if (!probs) return null;

  // 先按配额抽池
  const draw = rng();
  let acc = 0;
  let chosen = null;
  for (const p of POOLS) {
    if (!(probs[p] > 0)) continue;
    acc += probs[p];
    if (draw < acc) { chosen = p; break; }
  }
  if (!chosen) chosen = POOLS.find(p => probs[p] > 0);

  return { word: pickWeighted(pools[chosen], states, params, rng), pool: chosen, probs };
}
