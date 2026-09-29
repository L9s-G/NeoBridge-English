/**
 * LLM 调用限速：串行队列 + 最小调用间隔。
 *
 * 本地代理 RPM 10 ⇒ 每 6 秒最多 1 次；默认 6500ms 留余量。
 * now / sleep 全部注入 —— 单测用假时钟断言时序，不真等 6.5 秒。
 *
 * 队列语义：
 *   · push(fn) 依次执行，前一个 settle 后才轮到下一个（串行）
 *   · 每次执行前补足距上次**发起**时间的间隔
 *   · fn 抛错不影响后续任务（错误原样抛给该次调用方）
 */

export const DEFAULT_MIN_INTERVAL = 6500;

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function createQueue({
  minIntervalMs = DEFAULT_MIN_INTERVAL,
  now = () => Date.now(),
  sleep = defaultSleep,
} = {}) {
  let chain = Promise.resolve();
  let lastStart = null;

  return function push(fn) {
    const task = async () => {
      if (lastStart !== null) {
        const wait = lastStart + minIntervalMs - now();
        if (wait > 0) await sleep(wait);
      }
      lastStart = now();
      return fn();
    };
    // 前一个成功与否都要轮到下一个：两个处理器都指向 task
    chain = chain.then(task, task);
    return chain;
  };
}
