/**
 * 字典查询（纯函数）：只匹配词形 —— 不看中文释义、不看例句。
 *
 * 规则（产品拍板）：
 *   · 全量 5008 条（含短语，如 take off）
 *   · 大小写不敏感、首尾与内部空白折叠
 *   · 排序：完全相同 > 前缀匹配 > 包含匹配；同级词短的在前，再按字母序
 *
 * 只返回原始词对象（引用不变），渲染与展示上限（显示前 N 条）由调用方决定。
 */

function normalize(text) {
  return String(text == null ? '' : text).trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * @param {Array}  words   词包 words（每条至少有 w）
 * @param {string} query   用户输入
 * @returns {Array} 命中的词对象，按 规则排序；空查询 / 无命中返回 []
 */
export function searchWords(words, query) {
  const q = normalize(query);
  if (!q) return [];

  const hits = [];
  for (const w of words || []) {
    const form = normalize(w.w);
    if (!form) continue;
    let rank = -1;
    if (form === q) rank = 0;
    else if (form.indexOf(q) === 0) rank = 1;
    else if (form.indexOf(q) > 0) rank = 2;
    if (rank >= 0) hits.push({ w, form, rank });
  }

  hits.sort((a, b) =>
    a.rank - b.rank
    || a.form.length - b.form.length
    || (a.form < b.form ? -1 : a.form > b.form ? 1 : 0));
  return hits.map(x => x.w);
}
