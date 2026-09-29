/**
 * 答题 session：持有状态、串起流程。
 *
 * 三个模块各管一层，互不越界：
 *   core/queue.js   抽队列（纯函数，Node 可单测）
 *   ui/views.js     把状态画成 DOM（无状态）
 *   本文件           作答 → 更新进度 → 落库 → 直接跳下一题
 *
 * 流程只有"抽卡复习"一种：先看到词，点「开」翻面，标一档就走。
 */

import { withParams } from '../core/params.js';
import { dayKey } from '../core/day.js';
import { applyAnswer, SIGNAL } from '../core/mastery.js';
import { createState, markSeen } from '../core/progress.js';
import { buildQueue } from '../core/queue.js';
import { saveDaily, saveProgress } from '../db/stores.js';
import { playAudio } from './audio-download.js';
import { fitWord, h, questionView, replaceChildren, summaryView } from './views.js';

/** 当前题卡根节点；横竖屏 / 窗口变宽后按新可用宽度重算字号（模块级只挂一个监听） */
let activeCard = null;
if (typeof window !== 'undefined') {
  window.addEventListener('resize', () => {
    if (activeCard) fitWord(activeCard);
  });
}

/**
 * @param {object} opts.db        IndexedDB 连接
 * @param {Array}  opts.words     词包里的全部词
 * @param {string} opts.baseUrl   词包的官方链接前缀，透传给答题卡（只有背面用）
 * @param {object} opts.states    wordKey → 进度（本文件就地更新，随后逐题落库）
 * @param {number} opts.size      本轮题数
 * @param {object} opts.host      答题容器
 * @param {Function} opts.onExit  点"退出 / 回到首页"时回调
 * @param {Function} [opts.onPlay] 正面 🔊 的播放实现，默认放本地发音
 * @param {Map}     [opts.extMap] wordKey → 扩展条目（ext-loader 产出）；缺省时卡背无扩展区
 */
export function openSession({
  db, words, baseUrl, states, size, host, onExit, onPlay = playAudio, extMap = null,
  params = withParams(), now = () => Date.now(), rng = Math.random,
}) {
  const byKey = new Map(words.map(w => [w.k, w]));
  const results = [];

  let queue = [];
  let index = 0;
  let flipped = false;
  let answered = null;

  /* ---------------- 流程 ---------------- */

  async function answer(signal) {
    if (answered) return;
    answered = signal;

    const k = queue[index].k;
    const t = now();
    const prev = states[k] || createState(t, k);
    const nextState = applyAnswer(markSeen(prev, t), signal, t, params);
    states[k] = nextState;
    results.push({ k, signal });

    // 先落库再翻页：中途关页面也不会丢这一题
    try {
      await saveProgress(db, nextState);
      await saveDaily(db, { day: dayKey(t), k, at: t, wrong: signal === SIGNAL.WRONG });
    } catch (err) {
      console.warn('进度写入失败：', err);
    }

    next();
  }

  function next() {
    index += 1;
    flipped = false;
    answered = null;
    paint();
  }

  function summary() {
    const counts = { right: 0, fuzzy: 0, wrong: 0 };
    const wrongWords = [];
    for (const r of results) {
      counts[r.signal] += 1;
      if (r.signal === 'wrong') wrongWords.push(byKey.get(r.k));
    }
    return { total: results.length, counts, wrongWords };
  }

  function practice() {
    const { wrongWords } = summary();
    if (wrongWords.length) start(wrongWords, wrongWords.length);
  }

  function start(candidates, n) {
    queue = buildQueue({ words: candidates, states, params, size: n, rng });
    index = 0;
    flipped = false;
    answered = null;
    results.length = 0;
    paint();
  }

  /* ---------------- 渲染 ---------------- */

  function header() {
    return h('div', { class: 'session-head' },
      h('span', null, `${index + 1} / ${queue.length}`),
      h('button', { class: 'btn ghost', onclick: () => onExit() }, '退出'),
    );
  }

  function paint() {
    replaceChildren(host);

    if (index >= queue.length) {
      const data = summary();
      activeCard = null;
      host.append(summaryView({
        ...data,
        onPractice: practice,
        onExit: () => onExit(),
      }));
      return;
    }

    const card = questionView({
      word: byKey.get(queue[index].k),
      baseUrl,
      flipped,
      ext: extMap ? extMap.get(queue[index].k) : null,
      onFlip: () => { flipped = true; paint(); },
      onAnswer: answer,
      onPlay,
    });
    host.append(header(), card);
    activeCard = card;
    fitWord(card);   // 入 DOM 后立刻按可用宽度缩到单行（同帧，无闪变）
  }

  start(words, size);
}
