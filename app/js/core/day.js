/**
 * 本地时区的"天"相关的纯函数。
 * 放在 core/ 是为了能直接单测 —— 不碰 DOM，也不碰 IndexedDB。
 */

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const pad = n => String(n).padStart(2, '0');

/** 本地日期键：2026-09-28（字典序 == 时间序，可以直接当索引范围用） */
export function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 最近 n 天的日期键，从旧到新，最后一项是今天 */
export function lastDays(n, now = Date.now()) {
  const base = new Date(now);
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    out.push(dayKey(new Date(base.getFullYear(), base.getMonth(), base.getDate() - i)));
  }
  return out;
}

/** 日期键 → 展示用："9月28日 周一"。自己拆字符串，避免被当成 UTC 解析 */
export function dayLabel(key) {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return `${m}月${d}日 ${WEEK[date.getDay()]}`;
}

/** 今天 / 昨天 / N 天前 */
export function relDay(ms, now = Date.now()) {
  if (ms == null) return '';
  const diff = Math.round((Date.parse(dayKey(now)) - Date.parse(dayKey(ms))) / 86400000);
  if (diff <= 0) return '今天';
  if (diff === 1) return '昨天';
  return `${diff} 天前`;
}
