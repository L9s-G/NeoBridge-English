/**
 * 调度引擎的全部可调常数 —— 调参只改这一个文件。
 *
 * 换算法则改 weight.js / mastery.js / pools.js 之一。三者都是纯函数、
 * 无 IO、签名固定，改实现不会牵动 scheduler.js 的抽样流程。
 */

export const DEFAULT_PARAMS = {
  /** 等级权重：B2 出现得更频繁 */
  levelWeight: { B2: 1.4, B1: 1.0 },

  /** 掌握度抑制指数，越大则"已掌握"的词被抽中的概率降得越快 */
  masteryExponent: 1.6,

  /** 池内新鲜度衰减系数：见得越多越不优先，防止同池里老词霸屏 */
  freshnessDecay: 0.1,

  /** mastery 低于此值即划入错词池 */
  errPoolThreshold: 0.45,

  /**
   * 错过的词要连续答对几次才算"恢复"。
   * 只影响两处：错词名单的收录、错词池的划分 —— **不进权重公式**。
   */
  recoverStreak: 2,

  /**
   * 三池配额随 coverage（新词完成度）从 start 线性走到 end。
   * 新词还没过完时错词只占 10%，过完后抬到 40% —— 这正是
   * "错误与新词的比例"的实现方式，错误加成不进权重公式。
   */
  quotas: {
    start: { new: 0.75, err: 0.10, rev: 0.15 },
    end: { new: 0.30, err: 0.40, rev: 0.30 },
  },

  /**
   * 作答信号 → mastery 变化。
   * mul 表示乘上去（负向），add 表示向 1 逼近的增量（正向）。
   */
  masteryDelta: {
    wrong: { mul: 0.45 },
    fuzzy: { mul: 0.75 },
    right: { add: 0.18 },
    examRight: { add: 0.30 },
  },
};

/** 复制一份参数并合并覆盖项（含已知的嵌套字段），调用方不应直接改 DEFAULT_PARAMS */
export function withParams(overrides = {}) {
  const p = overrides.quotas || {};
  return {
    ...DEFAULT_PARAMS,
    ...overrides,
    levelWeight: { ...DEFAULT_PARAMS.levelWeight, ...(overrides.levelWeight || {}) },
    quotas: {
      start: { ...DEFAULT_PARAMS.quotas.start, ...(p.start || {}) },
      end: { ...DEFAULT_PARAMS.quotas.end, ...(p.end || {}) },
    },
    masteryDelta: { ...DEFAULT_PARAMS.masteryDelta, ...(overrides.masteryDelta || {}) },
  };
}
