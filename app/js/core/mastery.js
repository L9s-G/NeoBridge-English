/**
 * 作答信号 → 掌握度更新。
 *
 * 抽卡复习的三档标记、以及将来考试题型只是产生不同的信号，
 * 调度器本身不关心这个词是被哪种题型测过的。
 */

export const SIGNAL = Object.freeze({
  RIGHT: 'right',           // 按钮"熟悉"
  FUZZY: 'fuzzy',           // 按钮"一般"
  WRONG: 'wrong',           // 按钮"标记" / 题型答错
  EXAM_RIGHT: 'examRight',  // 考试题型答对（主动回忆，增益高于自评）
});

const clamp01 = n => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * 返回更新后的状态（不修改入参）。
 *
 * 两组计数，用途完全不同：
 *   wrongStreak / rightStreak —— **连续**计数，答错给提示、错词恢复用
 *   wrongs / rights           —— **累计**计数，错词名单的收录依据
 * 权重公式一个都不看，只看 mastery 与 timesSeen。
 *
 * fuzzy 的处理是刻意的不对称：它不算错（不累计 wrongs、不中断 wrongStreak），
 * 但也绝不算对 —— 会把 rightStreak 清零，所以"连续答对两次"必须两次都干净。
 */
export function applyAnswer(state, signal, now = null, params) {
  const rule = params.masteryDelta[signal];
  if (!rule) throw new Error(`unknown signal: ${signal}`);

  const prev = state || {};
  const mastery = prev.mastery ?? 0;
  const next = { ...prev };

  next.mastery = rule.mul !== undefined
    ? clamp01(mastery * rule.mul)
    : clamp01(mastery + (1 - mastery) * rule.add);

  next.lastResult = signal;
  next.answers = (prev.answers || 0) + 1;
  next.lastAnswerAt = now;

  if (signal === SIGNAL.RIGHT || signal === SIGNAL.EXAM_RIGHT) {
    next.rights = (prev.rights || 0) + 1;
    next.wrongStreak = 0;
    next.rightStreak = (prev.rightStreak || 0) + 1;
  } else if (signal === SIGNAL.WRONG) {
    next.wrongStreak = (prev.wrongStreak || 0) + 1;
    next.wrongs = (prev.wrongs || 0) + 1;
    next.rightStreak = 0;
    next.lastWrongAt = now;
  } else {
    // fuzzy：不动 wrongStreak（不算错），清零 rightStreak（不算对）
    next.rightStreak = 0;
  }

  if (next.firstSeenAt == null) next.firstSeenAt = now;
  return next;
}
