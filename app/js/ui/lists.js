/**
 * 首页两个清单卡片：最近 7 天复习卡 + 错词列表。
 * 只接收数据、只写 DOM —— 读取与存储在 stores.js，状态在 session.js。
 * 排序规则集中在这里，改顺序只动这个文件。
 */

import { dayKey, dayLabel, relDay } from '../core/day.js';
import { h, replaceChildren } from './views.js';

const WEEK_DAYS = 7;

/** 复制到剪贴板；现代浏览器走 clipboard API，iOS 12 没有它 → 回落 execCommand */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // clipboard 缺失时是同步 TypeError，落在下面这段仍在点击手势内执行
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length); // iOS Safari 需要显式选区才认
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

async function copyWithFeedback(btn, text) {
  const ok = await copyText(text);
  const label = btn.textContent;
  btn.textContent = ok ? '已复制' : '复制失败';
  setTimeout(() => { btn.textContent = label; }, 1500);
}

/** 卡片内排序：错过的排前面；同组内按当天作答时间从早到晚 */
const byWrongFirst = (a, b) => (b.wrong ? 1 : 0) - (a.wrong ? 1 : 0) || a.at - b.at;

/** 一行词：词 + 首个义项 */
function wordLine(word, extra) {
  const def = word?.senses?.[0]?.def;
  return h('li', null,
    h('strong', null, word?.w ?? '?'),
    extra,
    def ? h('span', { class: 'def' }, def) : null,
  );
}

/**
 * 可折叠体：点 head 开合，caret 标方向，body 用 hidden 属性收起。
 * head 内的按钮（复制）必须自己 stopPropagation，否则点复制会顺带展开。
 * caret 由调用方 append 进标题里，保证视觉位置可控。
 */
function collapsible(head, body) {
  let open = false;
  const caret = h('span', { class: 'caret' }, '▸');
  const sync = () => {
    body.hidden = !open;
    caret.textContent = open ? '▾' : '▸';
  };
  head.addEventListener('click', () => { open = !open; sync(); });
  sync();
  return caret;
}

/* ---------------- 最近 7 天 ---------------- */

/**
 * @param {object} card  #week-card 整个卡片（标题也由这里画）
 * @param {Array}  rows  daily 仓库记录 {day, k, at, wrong}
 * @param {Map}    byKey wordKey → 词
 */
export function renderWeek(card, rows, byKey) {
  const today = dayKey(Date.now());
  const days = [];
  const base = new Date();
  // 今天在最上面，越往下越旧
  for (let i = 0; i < WEEK_DAYS; i++) {
    days.push(dayKey(new Date(base.getFullYear(), base.getMonth(), base.getDate() - i)));
  }

  replaceChildren(card, h('h2', null, '最近 7 天'));
  for (const day of days) {
    const items = rows.filter(r => r.day === day && byKey.has(r.k)).sort(byWrongFirst);
    card.append(dayCard(day, items, byKey, day === today));
  }
}

function dayCard(day, items, byKey, isToday) {
  const count = items.length;
  const text = items.map(r => byKey.get(r.k).w).join('; ');
  const title = h('span', { class: 'day-title' },
    `${dayLabel(day)}${isToday ? '（今天）' : ''}${count ? ` · ${count}` : ''}`);

  const head = h('div', { class: 'day-head' },
    title,
    count
      ? h('button', {
          class: 'btn ghost',
          onclick: e => { e.stopPropagation(); copyWithFeedback(e.currentTarget, text); },
        }, '复制')
      : null,
  );

  const body = count
    ? h('ul', { class: 'day-list' }, items.map(r => wordLine(byKey.get(r.k), r.wrong
        ? h('span', { class: 'flag', title: '这天练错了' }, '●') : null)))
    : null;   // 没词就只剩标题行，不占位显示状态文字

  // 有词才可折叠（空卡没有 body，无可折叠）
  if (count) title.append(collapsible(head, body));

  return h('div', { class: 'day-card' + (count ? '' : ' empty') }, head, body);
}

/* ---------------- 错词列表 ---------------- */

/**
 * @param {object} card    #wrong-card 整个卡片（标题数量也由这里画）
 * @param {Array} entries  [{k, lastWrongAt}]，已按 lastWrongAt 升序
 *                        （最久没练的排最上面）
 */
export function renderWrongList(card, entries, byKey) {
  const title = h('h2', null, entries.length ? `强化记忆 · ${entries.length}` : '强化记忆');
  const head = h('div', { class: 'day-head wrong-head' }, title);

  const body = entries.length
    ? h('ul', { class: 'wrong-full' },
        entries.map(e => wordLine(byKey.get(e.k), h('span', { class: 'when' }, relDay(e.lastWrongAt)))),
      )
    : h('p', { class: 'day-empty' }, '暂无');

  if (entries.length) title.append(collapsible(head, body));

  replaceChildren(card, head, body);
}
