/**
 * 词层抽样权重：等级 × 掌握度抑制 × 池内新鲜度。
 *
 * coverage（新词完成度）与 session 去重不在这里 —— 它们分别归 pools.js
 * 和 scheduler.js 管。把五个维度拆到三层，换掉权重算法就不会牵动
 * 配额与去重逻辑。
 */

/** 词包里是 levels 数组（跨级词保留多个），权重取最高等级 */
export function topLevel(levels) {
  return (levels || []).slice().sort().pop() || null;
}

export function wordWeight(word, state, params) {
  const level = params.levelWeight[topLevel(word.levels)] ?? 1;

  const mastery = state ? state.mastery ?? 0 : 0;
  const masteryFactor = Math.pow(1 - mastery, params.masteryExponent);

  const timesSeen = state ? state.timesSeen ?? 0 : 0;
  const freshness = 1 / (1 + params.freshnessDecay * timesSeen);

  return level * masteryFactor * freshness;
}
