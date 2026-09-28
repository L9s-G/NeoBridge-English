/**
 * 答题界面的渲染：只接收数据、只写 DOM，不做任何状态判断。
 * 状态由 session.js 维护，这里保证一个函数一次就能把画面画对。
 *
 * 全部走 textContent —— 将来中文释义来自 LLM，不能当 HTML 解析。
 *
 * 卡面怎么显示（徽章、字号档、Keyword、链接指向哪）全部由 card-info.js 算好，
 * 这里只画。正面的 🔊：有本地发音就调 onPlay（按钮，不是链接），否则回落 YouGlish；
 * 官方详情链接全在背面。
 */

import { audioNamesOfWord } from './audio-download.js';
import {
  distinctPos, keywordText, lenClass, posTitle, senseUrl, showGrouping, youglishUrl,
} from './card-info.js';

/** 外链统一新标签打开：套进 PWA 里会丢掉当前 session */
const EXT = { target: '_blank', rel: 'noopener' };

/**
 * 清空 el 并替换成给定子节点 —— `Element.replaceChildren()` 要 Safari 14+，
 * iOS 12（Safari 12）没有，这里给出等价实现，新旧浏览器共用这一份。
 */
export function replaceChildren(el, ...nodes) {
  while (el.firstChild) el.removeChild(el.firstChild);
  for (const node of nodes) el.append(node);
}

/** tag + 属性 + 子节点 → 元素；属性名 on* 绑事件，class 单独识别。props 可传 null */
export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of children.flat(9)) {
    if (child == null) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** 翻面后的三档标记：按钮文案 → 作答信号（信号名归 mastery.js 管，只换显示文案） */
export const ANSWERS = Object.freeze([
  { label: '熟悉', signal: 'right', cls: 'ok' },
  { label: '一般', signal: 'fuzzy', cls: 'mid' },
  { label: '标记', signal: 'wrong', cls: 'no' },
]);

/** 未翻面时的唯一动作 */
const FLIP_LABEL = '开';

function front(word, onPlay) {
  const ipas = [...new Set(word.senses.map(s => s.ipa).filter(Boolean))].slice(0, 2);
  const posList = distinctPos(word);
  const keywords = keywordText(word);
  const audios = audioNamesOfWord(word);
  const n = word.senses.length;

  return h('div', { class: 'q-front' },
    h('p', { class: 'q-tags' },
      posList.map(pos => h('span', { class: 'tag', title: posTitle(pos) }, pos)),
      n > 1 ? h('span', { class: 'tag', title: `${n} 个义项` }, `${n} 义项`) : null,
    ),
    h('p', { class: `q-word ${lenClass(word)}` }, word.w),
    // 读音行恒定：有音标就显示音标，喇叭始终在后面；无音标只剩喇叭
    h('p', { class: 'q-sound' },
      ipas.length ? h('span', { class: 'q-ipa' }, ipas.map(i => `/${i}/`).join('   ')) : null,
      audios.length
        ? h('button', {
            class: 'q-bell', type: 'button', title: '本地发音',
            onclick: () => onPlay && onPlay(audios),
          }, '🔊')
        : h('a', { class: 'q-bell', href: youglishUrl(word), title: 'YouGlish 真实发音', ...EXT }, '🔊'),
    ),
    keywords.length ? h('p', { class: 'q-key' }, 'Keyword：', keywords.join(' / ')) : null,
  );
}

/** 一个义项；mixedPos 为真时 pos 已经提到分组标题，meta 里不再重复 */
function senseBlock(baseUrl, sense, withPos) {
  return h('div', { class: 'sense' },
    h('p', { class: 'sense-meta' },
      h('span', { class: 'lvl' }, sense.level),
      withPos && sense.pos
        ? [' · ', h('span', { class: 'meta-pos', title: posTitle(sense.pos) }, sense.pos)]
        : null,
      sense.topic ? ` · ${sense.topic}` : '',
      ' · ',
      // 链接文本用义项自己的词头（短语卡各义项词头可能不同，如 humour / sense）
      h('a', { class: 'sense-link', href: senseUrl(baseUrl, sense), ...EXT }, sense.hw, ' ↗'),
    ),
    h('p', { class: 'sense-def' }, sense.def),
    sense.guide ? h('p', { class: 'sense-guide' }, sense.guide) : null,
    (sense.ex || []).slice(0, 2).map(ex => h('p', { class: 'sense-ex' }, `“${ex}”`)),
  );
}

function back(word, baseUrl) {
  const grouped = showGrouping(word);

  return h('div', { class: 'q-back' },
    grouped
      ? distinctPos(word).map(pos => h('div', { class: 'pos-group' },
          h('p', { class: 'pos-head' }, h('span', { class: 'tag', title: posTitle(pos) }, pos)),
          word.senses.filter(s => s.pos === pos).map(s => senseBlock(baseUrl, s, false)),
        ))
      : word.senses.map(s => senseBlock(baseUrl, s, true)),
  );
}

/**
 * 一张答题卡。只有两种状态：没翻面 → 一个「开」；翻了面 → 三档标记。
 * 作答后 session.js 会直接跳下一题，这里不画"已记录 / 下一步"。
 * @param {object}   o.word      词
 * @param {string}   o.baseUrl   词包里的官方链接前缀，只有背面用得到
 * @param {boolean}  o.flipped   是否已翻面
 * @param {Function} [o.onPlay]  正面 🔊：传入该卡的发音文件名数组；不传则回落 YouGlish
 */
export function questionView({ word, baseUrl, flipped, onFlip, onAnswer, onPlay }) {
  const root = h('div', { class: 'q' }, front(word, onPlay));
  if (flipped) root.append(back(word, baseUrl));

  root.append(h('div', { class: 'q-actions' },
    flipped
      ? ANSWERS.map(a =>
          h('button', { class: `btn wide ans ${a.cls}`, onclick: () => onAnswer(a.signal) }, a.label))
      : h('button', { class: 'btn wide', onclick: onFlip }, FLIP_LABEL),
  ));
  return root;
}

/**
 * 让正面词按卡片可用宽度缩到单行：先回到 CSS 的档位封顶，量出自然宽度，
 * 超出可用宽度就按比例缩小（只缩不放大，永不越过封顶）。
 * 必须在元素已入 DOM 后调用 —— 要靠布局量宽；session.js 在 append 的同一帧
 * 调用，用户看不到中间字号。可重复调用（横竖屏切换后按新宽度重算）。
 * @param {Element} root questionView() 返回的卡片根节点
 */
export function fitWord(root) {
  const el = root.querySelector('.q-word');
  if (!el) return;

  el.style.fontSize = '';                        // 清掉上次算的，避免重复调用越缩越小
  const avail = el.clientWidth;                  // 卡片可用宽度（p 是块级，等于容器内宽）
  if (!avail) return;

  // Range 量的是文本自己的宽度，不受居中对齐 / overflow 裁剪影响
  const range = document.createRange();
  range.selectNodeContents(el);
  const natural = range.getBoundingClientRect().width;
  if (!(natural > avail)) return;                // 放得下就保持封顶字号

  const cap = parseFloat(getComputedStyle(el).fontSize);  // 当前封顶（px）
  if (!cap) return;
  // 向下取 0.1px：宁可小一点点也绝不溢出
  el.style.fontSize = `${Math.floor(cap * (avail / natural) * 10) / 10}px`;
}

/** 本轮小结 */
export function summaryView({ total, counts, wrongWords, onPractice, onExit }) {
  const rows = [
    ['完成题数', String(total)],
    ['熟悉', String(counts.right)],
    ['一般', String(counts.fuzzy)],
    ['标记', String(counts.wrong)],
  ];

  const list = h('ul', { class: 'wrong-list' },
    wrongWords.map(w => h('li', null, h('strong', null, w.w), ' — ', w.senses[0]?.def ?? '')),
  );

  return h('div', { class: 'q summary' },
    h('p', { class: 'q-word' }, '本轮完成'),
    h('dl', { class: 'sum-list' },
      rows.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)]),
    ),
    wrongWords.length
      ? h('div', { class: 'wrong-block' },
          h('p', { class: 'wrong-title' }, `标记的词（${wrongWords.length}）`),
          list,
        )
      : null,
    h('div', { class: 'q-actions' },
      wrongWords.length
        ? h('button', { class: 'btn primary wide', onclick: onPractice }, '重练这些词')
        : null,
      h('button', { class: 'btn wide', onclick: onExit }, '回到首页'),
    ),
  );
}
