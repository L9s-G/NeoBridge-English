/**
 * 单个词的进度状态。
 *
 * 存储（IndexedDB）由调用方负责，这里只管状态的形状与生命周期，
 * 因此是纯函数，可以在 Node 里直接单测。
 */

/**
 * @param {number|null} now 时间戳
 * @param {string|null} k   wordKey —— progress 仓库的 keyPath，
 *                          记录一旦要写库就必须带着它，所以从创建时就带上
 */
export function createState(now = null, k = null) {
  return {
    k,
    mastery: 0,          // 掌握度 [0,1]，抽样与划池的核心
    lastResult: null,    // 'right' | 'fuzzy' | 'wrong' | 'examRight' | null
    timesSeen: 0,        // 被抽中的次数，池内新鲜度用
    answers: 0,
    rights: 0,
    wrongs: 0,           // 累计答错次数，>0 即进过错词名单
    wrongStreak: 0,      // 连续答错，用于"连续答错"提示
    rightStreak: 0,      // 连续答对，错词恢复条件用
    firstSeenAt: now,
    lastSeenAt: now,
    lastAnswerAt: null,
    lastWrongAt: null,   // 最后一次答错的时间，错词名单按它排序
  };
}

/**
 * 出现一次就记一次。答错的冷却由配额控制，不使用分钟级冷却——
 * session 内去重见 scheduler.js。
 */
export function markSeen(state, now = null) {
  const next = state ? { ...state } : createState(now);
  next.timesSeen = (next.timesSeen || 0) + 1;
  next.lastSeenAt = now;
  if (next.firstSeenAt == null) next.firstSeenAt = now;
  return next;
}

/**
 * coverage = 本包里已作答的词数 / 本包词数，按当前激活的词包各自计算。
 *
 * 直接收 words 数组而不是一个总数：装了多个包时，别的包的进度
 * 自动被排除在外，分子分母天然同源，不会算错。
 */
export function coverageOf(states, words) {
  if (!words || !words.length) return 0;
  let answered = 0;
  for (const w of words) {
    const s = states[w.k];
    if (s && s.lastResult != null) answered++;
  }
  return answered / words.length;
}
