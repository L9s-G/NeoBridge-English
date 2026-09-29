/**
 * 答题卡的派生信息：全是纯函数，不碰 DOM，Node 可直接单测。
 *
 * 分工：
 *   views.js  只负责把这里算好的结果画成元素
 *   本文件    只负责"这张卡该怎么显示、链接该指向哪"
 *
 * 两条硬约束（改之前先想清楚）：
 *   1. 正面不放任何链接 —— 正面是测验面，链接会干扰作答；全部 URL 放背面详情。
 *      喇叭是唯一的半个例外：没有本地发音时回落成 YouGlish 的 <a>（跳外链、不导航
 *      离当前页），有本地发音时是 <button> 播放，根本不是链接。
 *   2. 义项级的 senseUrl 是唯一能覆盖全部 244 张多词条卡的链接，
 *      因为每张卡的 senses 都触及 entries[1:]（已用数据验证 244/244）。
 */

/** 词性 → 中文；键名与词包里 senses[].pos 的英文原文一一对应（共 14 种） */
export const POS_ZH = Object.freeze({
  noun: '名词',
  verb: '动词',
  adjective: '形容词',
  adverb: '副词',
  phrase: '短语',
  'phrasal verb': '短语动词',
  preposition: '介词',
  pronoun: '代词',
  conjunction: '连词',
  determiner: '限定词',
  'modal verb': '情态动词',
  exclamation: '感叹词',
  number: '数词',
  'auxiliary verb': '助动词',
});

/** 词性中文；没见过的原样返回，徽章不至于空掉 */
export function posTitle(pos) {
  return POS_ZH[pos] || pos || '';
}

/** 卡上出现过的词性，去重保序 —— 徽章行用，混合词性卡的分组也用 */
export function distinctPos(word) {
  const seen = [];
  for (const sense of word?.senses || []) {
    if (sense.pos && !seen.includes(sense.pos)) seen.push(sense.pos);
  }
  return seen;
}

/** 只有混合词性才分组（389 张）；单一词性的 4619 张保持紧凑不分组 */
export function showGrouping(word) {
  return distinctPos(word).length > 1;
}

/** 正面词的字号档：按词长分 4 档，档位只决定字号「封顶」（app.css .q-word）；
 *  超出卡片可用宽度时由 views.js 的 fitWord() 再按宽度缩小到单行 */
export function lenClass(word) {
  const n = (word?.w || '').length;
  if (n <= 6) return 'len-s';
  if (n <= 12) return 'len-m';
  if (n <= 20) return 'len-l';
  return 'len-xl';
}

const norm = s => (s || '').trim().toLowerCase();

/**
 * 正面 "Keyword：" 行的词头列表，去重保序。
 * 词头与正面词相同（纯单词）时返回空数组 —— 正面不渲染该行，
 * 否则 3709 张卡会显示与主词一模一样的重复文字。
 */
export function keywordText(word) {
  const seen = [];
  for (const sense of word?.senses || []) {
    const hw = sense.hw;
    if (hw && norm(hw) !== norm(word?.w) && !seen.includes(hw)) seen.push(hw);
  }
  return seen;
}

/** YouGlish 英式发音页；搜索词用整卡的 w，短语（take off）也能命中 */
export function youglishUrl(word) {
  return `https://youglish.com/pronounce/${encodeURIComponent(word?.w || '')}/english/uk`;
}

/** 词包里的官方链接前缀；只有背面用得到（正面永远不放链接） */
export function senseUrl(baseUrl, sense) {
  return `${baseUrl || ''}${sense?.refid || ''}`;
}

/** family rel → 中文（validate 只认 derived / sibling 两个枚举） */
export const REL_ZH = Object.freeze({ derived: '派生', sibling: '同族' });

/**
 * 卡背扩展区的 <summary> 文案：按实际有内容的块拼 ——
 * 首发词源块（origin/path/story）整块留空，就只报「中文详解 / 家族」，不虚报。
 */
export function extSummary(ext) {
  const parts = ['中文详解'];
  const ety = (ext && ext.etymology) || {};
  if (ety.origin || ety.story || (ety.path || []).length) parts.push('词源');
  if ((ext && ext.family || []).length) parts.push('家族');
  return `扩展信息 · ${parts.join(' / ')}`;
}

/** 演变链：form（lang·meaning） → form（lang·meaning） … */
export function extPathText(path) {
  return (path || []).map(p => `${p.form}（${p.lang}·${p.meaning}）`).join(' → ');
}

/** family chip 的悬浮标注：派生·形容词 —— 可见文本只留「词 + 中文」（与 llm-test 一致） */
export function extFamilyLabel(item) {
  const rel = REL_ZH[item.rel] || item.rel || '';
  const pos = posTitle(item.pos);
  return [rel, pos].filter(Boolean).join('·');
}
