/**
 * 整轮题队列：一次性抽好，而不是逐题抽。
 *
 * 与逐题抽样在数学上等价（session 去重已经保证不重复），换来三件事：
 *   1. 进度条能显示"第 3 / 20"
 *   2. 一轮中途退出只丢队列，进度已逐题落库
 *   3. 测试能直接断言队列内容
 *
 * 纯函数，随机数由调用方注入。
 */

import { coverageOf } from './progress.js';
import { pickNext } from './scheduler.js';

/**
 * @param {object}   opts.words    候选词（整包，或"只练错词"的子集）
 * @param {object}   opts.states   wordKey → 进度状态
 * @param {object}   opts.params   调度参数
 * @param {number}   opts.size     想要的题数
 * @param {function} opts.rng      随机数源
 * @returns {Array<{k: string, pool: 'new'|'err'|'rev'}>} 实际队列（候选不足时更短）
 */
export function buildQueue({ words, states, params, size, rng = Math.random }) {
  if (!words || !words.length || size <= 0) return [];

  const coverage = coverageOf(states, words);
  const sessionSeen = new Set();
  const queue = [];

  for (let i = 0; i < size; i++) {
    const picked = pickNext({ words, states, params, coverage, sessionSeen, rng });
    if (!picked) break;                  // 候选词抽完了
    sessionSeen.add(picked.word.k);
    queue.push({ k: picked.word.k, pool: picked.pool });
  }
  return queue;
}
