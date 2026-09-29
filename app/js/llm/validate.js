/**
 * 词级扩展信息的结构校验。
 *
 * 只做**结构与形态**断言，不做语义断言（语义靠 prompt grounding）：
 *   zh         中文、长度区间
 *   family     单 token 形态、rel 枚举、pos 白名单、zh 简短、去重截断
 *   etymology  story 非空时才查中文与上限（story 是可选项：空、短都合法）
 *   全局       无 URL / 无 Markdown 链接
 *
 * 失败分两档：
 *   · 整条不合格（zh/story 缺失或超限、出现 URL）→ ok:false，调用方重试
 *   · 局部不合格（个别 family 项形态/pos 不对）→ 剔除该项，ok 仍为 true
 * 注意 dropped 只是**分析结果**，不是"静默丢弃许可"：词级管线（pipeline.js）
 * 把 dropped 非空视为整条不合格，走定向修复 → 反馈重试，修不好才进人工清单。
 *
 * 纯函数，Node 与浏览器共用。
 */

import { FAMILY_POS } from './prompts.js';

const CJK = /[一-鿿]/;
const FAMILY_W = /^[A-Za-z][A-Za-z0-9'-]{0,30}$/;
const URLISH = /(https?:\/\/|www\.|\bwww\b|\[.*?\]\(.*?\))/i;
// Markdown 装饰符号（**加粗** / *斜体* / `代码` / ~~删除线）：纯排版非语义，剥掉即可，
// 不判错误——模型偶尔冒出来（v2 实测 2/20），为它重试不值一次限速间隔
const stripDecor = s => String(s).replace(/\*\*?|__|~~|`/g, '');
// family 项的自我标注（模型硬拗出一条后又在 zh 里写"应删"之类）：整条剔除
const SELF_NOTE = /应删|示例错误|待核|不相关|无关|疑似|不确定|明显错误/;

const LIMITS = {
  zh: [100, 800],
  familyZh: 30, // prompt 要求 ≤20，硬线 30：与 zh/story 一样的"目标窄、硬线宽"宽容带
  storyMax: 600, // story 是可选项：空合法、短也合法（有信息就行），只有上限防注水
  familyMax: 8,
};

const hasZh = s => CJK.test(s);
const len = s => Array.from(s).length; // 按码点计数，免得把汉字算成两

/**
 * @param input  parseWordExt 的返回值
 * @param wordK  词的 wordKey（family 不得自指）
 * @returns {ok, cleaned, errors[], dropped[]}
 *          cleaned 在 ok:true 时可直接落库；ok:false 时是尽力修复的产物
 */
export function validateWordExt(input, wordK) {
  const errors = [];
  const dropped = [];

  const story = stripDecor(input.etymology.story || '').trim(); // parseWordExt 已归一：字符串，可为空
  const zh = stripDecor(input.zh).trim();
  if (URLISH.test(zh) || URLISH.test(story) || URLISH.test(stripDecor(input.etymology.origin || ''))) {
    errors.push('内容含 URL / Markdown 链接');
  }

  const zhLen = len(zh);
  if (!hasZh(zh)) errors.push('zh 不含中文');
  if (zhLen < LIMITS.zh[0]) errors.push(`zh 过短（${zhLen} < ${LIMITS.zh[0]}）`);
  if (zhLen > LIMITS.zh[1]) errors.push(`zh 过长（${zhLen} > ${LIMITS.zh[1]}）`);

  // story 是可选项：空、短都合法（短而有信息 > 空；空 > 硬凑），非空只防超长与非中文
  if (story) {
    if (!hasZh(story)) errors.push('story 不含中文');
    if (len(story) > LIMITS.storyMax) errors.push(`story 过长（${len(story)} > ${LIMITS.storyMax}）`);
  }

  // family 局部清洗：只剔坏项，不判整条死刑
  const family = [];
  const seen = new Set();
  for (const item of input.family) {
    const w = item && typeof item.w === 'string' ? item.w.trim() : '';
    const why = !w ? '缺 w'
      : !FAMILY_W.test(w) ? `w 非单 token：${w}`
      : w.toLowerCase() === String(wordK || '').toLowerCase() ? 'w 与目标词相同'
      : seen.has(w.toLowerCase()) ? '重复'
      : !item.rel || !['derived', 'sibling'].includes(item.rel) ? `rel 非法：${item && item.rel}`
      : !item.pos || !FAMILY_POS.includes(item.pos) ? `pos 非法：${item && item.pos}`
      : typeof item.zh !== 'string' || !item.zh.trim() ? '缺 zh'
      : SELF_NOTE.test(item.zh) ? '模型自标注（应删/无关之类），整条剔除'
      : !hasZh(item.zh) ? 'zh 不含中文'
      : len(item.zh) > LIMITS.familyZh ? `zh 超长（>${LIMITS.familyZh}）`
      : null;
    if (why) {
      dropped.push({ w, why, item }); // item 原样带给修复轮（要原 zh 才能压缩重写）
      continue;
    }
    seen.add(w.toLowerCase());
    family.push({ w, rel: item.rel, pos: item.pos, zh: stripDecor(item.zh).trim() });
    if (family.length >= LIMITS.familyMax) break;
  }

  const cleaned = {
    zh,
    family,
    etymology: {
      origin: stripDecor(input.etymology.origin || '').trim(),
      story,
      path: (input.etymology.path || []).filter(
        p => p && typeof p.form === 'string' && p.form.trim() && !URLISH.test(p.form),
      ),
    },
  };

  return { ok: errors.length === 0, cleaned, errors, dropped };
}

export { LIMITS as VALIDATE_LIMITS };
