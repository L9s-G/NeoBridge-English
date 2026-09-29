/**
 * 词级扩展信息（中文详解 / 家族词 / 词源）的 prompt 构建与解析。
 *
 * 生成与解析只此一份 —— 批量脚本 gen-ext.mjs 和测试页 llm-test.html
 * 走同一套代码路径，这就是"路径可靠性"的验证对象。
 *
 * 一轮调用出三段（RPM 10 下省一半时间）：
 *   zh         词级中文详解（不是义项数组：全部义项喂给模型，由它组织）
 *   family     家族词（derived/sibling，只要单词不要短语）
 *   etymology  词源与演变（origin 一句话 + story 中文叙述 + path 演变链）
 *
 * groundings 全部来自词包官方数据（senses / def / 例句 / 已有短语家族），
 * 模型只做组织与扩写 —— 不让它编定义，短语家族由代码算好告诉它"已有"，
 * 避免重复收录。
 *
 * 另含两条配套链路（gen-ext.mjs 与 llm-test.html 经 pipeline.js 共用）：
 *   修复   buildRepairPrompt  — family 局部问题定向缩写/改正，不动整份数据
 *   核查   buildVerifyPrompt  — 背靠背质检：只给官方义项+产出数据，不给生成 prompt
 */

import { extractJson } from './json.js';

export const PROMPT_VERSION = 3;

/** 家族词允许的 pos 白名单：词包 senses[].pos 的 14 种里去掉 phrase / phrasal verb
 *  （那两类必带空格，与"family 只收单 token"矛盾，永远用不到） */
export const FAMILY_POS = Object.freeze([
  'noun', 'verb', 'adjective', 'adverb', 'preposition', 'conjunction',
  'determiner', 'modal verb', 'pronoun', 'exclamation', 'number', 'auxiliary verb',
]);

const SYSTEM_PROMPT = `你是"牛B词典"：精通语源学、深谙现代英语用法的英语学习助手，服务对象是中文母语的 B2 学习者。

任务：针对用户给出的一个英语单词（含官方义项与场景关键字），生成一份**精简的**学习要点——
目标是帮用户记住这个词、让词立体起来，不是写词条全书，宁短勿长。

只输出一个 JSON 对象，不要 Markdown 围栏、不要任何解释文字。结构：
{
  "zh": "词级中文详解，200~500字",
  "family": [{"w":"accountant","rel":"derived|sibling","pos":"noun","zh":"会计人员，审计员"}],
  "etymology": {
    "origin": "一句话交代最早词源（语种+原形+原义）",
    "story": "0 或 100~180字的中文演变故事",
    "path": [{"form":"computare","lang":"Latin","meaning":"计算"}]
  }
}

三个顶层字段 zh、family、etymology **键缺一不可**；但下面两个字段的内容是**可选的**：
- family 没有真实同源词就给 []，story 不够有意思就给 ""——**宁可为空，也不要硬凑**。
  硬凑出来的家族词和注水的词源故事是垃圾，空值才是正确输出。
- story 与 family 为空是常态，不是失败。

zh 字段规则（核心，200~500字）：
- guide 是该义项的**场景关键字**（如 MONEY / ACCUSE / ELECTRICITY）。zh 按场景组织：
  每个场景一两句，讲清"什么场合、怎么用、和相近场景怎么分"（如 charge 收钱/指控/冲锋/充电各归各的场景）
- 按"核心义 → 引申义"连成一段，不逐义项罗列；点破一个最常见的易混/误用点
- **纯文本**：禁止 Markdown 符号（**加粗**、#、>、反引号、~~）。场景分点可以分行，
  每行写成"场景名：说明"，不要用 "1." 或 "-" 做项目符号
- 不引用例句、不复述官方英文释义；口语化，可用一句毒舌提醒收尾

family 字段规则（0~6 个，宁缺毋滥）：
- 只收**真实同源**的单词（derived 派生 / sibling 同源兄弟，如 count 之于 account）；
  拿不准真实同源关系才跳过，不要为凑数硬造
- 但明显的派生词别漏掉：run → runner / running、tear → tears 这种就该给。
  通常 2~5 个，真没有才 []
- 拿不准的词**整条不输出**；绝不要输出后又在 zh 里写"应删、示例错误、无关"
  这类自标注——不输出就是最好的标注
- rel 只能是 derived 或 sibling；w 必须是**单个单词**（无空格），不等于目标词，
  不得重复用户给出的短语家族
- pos 必须取自：noun, verb, adjective, adverb, preposition, conjunction, determiner,
  modal verb, pronoun, exclamation, number, auxiliary verb
- zh 是简明中文注释，不超过 20 字

etymology 字段规则：
- origin ≤60字，必给（语种+原形+原义，这是"立体感"最便宜的来源）
- story 可选：只在词源**能看出词义怎么从本义一路引申、真帮记忆**时写
  （100~180字，时间线式，可含文化典故）；平淡无奇就给 ""
- path 给 2~4 个关键形态，给不出就 []
- 全文中文，原词形与语种名保留原文

禁止：URL、Markdown 链接、LaTeX、编造例句来源。`;

/**
 * 构建一轮对话。
 * @param word      词包里的一条 word（k / w / senses / ...）
 * @param phrases   代码算出的官方短语家族（告诉模型"这些已有，别收进 family"）
 */
export function buildWordExtPrompt(word, phrases = []) {
  const senses = (word.senses || []).map(s => ({
    guide: s.guide,
    pos: s.pos,
    level: s.level,
    def: s.def,
    ex: (s.ex || []).slice(0, 1),
  }));

  const user = {
    word: word.w,
    officialSenses: senses,
    existingPhrases: phrases, // 代码从词包 entries 交叉算出，模型不得收进 family
  };

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `单词：${user.word}\n\n官方义项（guide 是场景关键字，如 MONEY/ACCUSE，zh 围绕这些场景组织）：\n${JSON.stringify(senses, null, 1)}\n\n已存在的短语家族（不要收进 family）：${phrases.length ? phrases.join(', ') : '（无）'}\n\n请输出 JSON。family / story 内容可为空（[] / ""），但三个顶层键都要有。` },
  ];
}

/**
 * 解析模型输出 → {zh, family[], etymology{}}。
 * 解析失败或形状不对会抛错，调用方按"重试 1 次 → 记 error"处理。
 * 可选项宽容：story 缺失/空 → ""；family 键必须在（缺失=没守结构）但内容可 []。
 */
export function parseWordExt(content) {
  const raw = extractJson(content);
  if (!raw || typeof raw !== 'object') throw new Error('parseWordExt: 不是 JSON 对象');
  if (typeof raw.zh !== 'string' || !raw.zh.trim()) throw new Error('parseWordExt: 缺 zh');
  if (!Array.isArray(raw.family)) throw new Error('parseWordExt: 缺 family 数组');
  const et = raw.etymology;
  if (!et || typeof et !== 'object') throw new Error('parseWordExt: 缺 etymology');
  const story = typeof et.story === 'string' ? et.story.trim() : '';

  return {
    zh: raw.zh.trim(),
    family: raw.family,
    etymology: {
      origin: typeof et.origin === 'string' ? et.origin.trim() : '',
      story,
      path: Array.isArray(et.path) ? et.path : [],
    },
  };
}

/* ---------------- 定向修复（family 局部问题：缩写/改正，不动整份数据） ---------------- */

const REPAIR_PROMPT = `你是数据修复器。给定目标英语单词和它"家族词列表"里有问题的条目，按要求改写，只输出一个 JSON 数组。

输出格式：[{"w":"eggplant","rel":"sibling","pos":"noun","zh":"改写后的注释"}]

规则：
- 只处理我给出的问题条目，不要新增、不要删除无关条目
- zh 超长：压缩到 20 字左右（绝不超 30），保留信息量最大的重点（区域用法差异、搭配、语法特性），宁可舍弃例词
- rel/pos 非法：改成正确枚举值（rel 只能是 derived 或 sibling；pos 用 noun/verb/adjective 等标准词性）
- w 本身有问题（非单词、与目标词相同、重复）或实在修不了的条目：直接省略该条，不要硬凑
- 注释必须是简明中文，不带 Markdown
只输出数组，不要解释。`;

/**
 * @param word  词包 word（只用 k/w 给上下文）
 * @param flagged [{w, rel, pos, zh, why}] validate 剔出来的问题条目
 */
export function buildRepairPrompt(word, flagged) {
  return [
    { role: 'system', content: REPAIR_PROMPT },
    { role: 'user', content: `目标词：${word.w}\n\n问题条目：\n${JSON.stringify(flagged, null, 1)}\n\n请输出修复后的数组。` },
  ];
}

/** 解析修复结果 → 条目数组（原样返回，由调用方合并后重新走 validate 复验） */
export function parseRepairItems(content) {
  const raw = extractJson(content);
  if (!Array.isArray(raw)) throw new Error('parseRepairItems: 不是 JSON 数组');
  return raw.filter(item => item && typeof item === 'object');
}

/* ---------------- 背靠背核查（第二端点，只给义项与数据，不给生成 prompt） ---------------- */

export const VERIFY_PROMPT_VERSION = 1;

const VERIFY_PROMPT = `你是严格的数据核查员，做"背靠背"质检：你不看生成者的提示词，只依据官方义项判断这份英语学习数据是否合格。

生成方被允许的风格（以下**不是**问题，不要扣分）：
- zh 口语化、按场景分行、可以有一句毒舌提醒收尾；给搭配、使用建议、易混点辨析都是应有内容
- 用法与例子不必逐字来自官方例句、不必标注来源——只要不虚构"某词典/某来源说"

你只查两类问题：
1. 事实错误：与官方义项矛盾的释义；明显编造或张冠李戴的词源（语种/原形/原义/演变链）；常识性硬伤
2. 结构违规：Markdown 符号（**加粗**、#、反引号等）、URL、缺字段；family 的 rel/pos 非法、注释与该项词语明显不对应、明显非同源的硬凑（拿不准是否同源就不要报）

只输出 JSON：
{"pass": true 或 false, "issues": [{"field": "zh | family[0].zh | family[0].pos | etymology.origin | etymology.story | etymology.path", "problem": "具体、可执行的问题"}]}

没有问题就输出 {"pass": true, "issues": []}。问题要具体到字段；拿不准的猜测不要写（宁可 pass）。`;

/**
 * @param word 词包 word（官方义项来源）
 * @param data validateWordExt 的 cleaned 产物
 */
export function buildVerifyPrompt(word, data) {
  const senses = (word.senses || []).map(s => ({
    guide: s.guide, pos: s.pos, level: s.level, def: s.def, ex: (s.ex || []).slice(0, 1),
  }));
  return [
    { role: 'system', content: VERIFY_PROMPT },
    {
      role: 'user',
      content: `目标词：${word.w}\n\n官方义项：\n${JSON.stringify(senses, null, 1)}\n\n待核查数据：\n${JSON.stringify(data, null, 1)}\n\n请输出 JSON 结论。`,
    },
  ];
}

/**
 * 解析核查结论 → {pass, issues:[{field, problem}]}。
 * 归一化：pass 只有在 true 且 issues 为空时才为 true（矛盾输出一律判不过）；
 * 结构缺失（既无 pass 也无 issues 数组）抛错，调用方按核查轮失败处理。
 */
export function parseVerifyVerdict(content) {
  const raw = extractJson(content);
  if (!raw || typeof raw !== 'object') throw new Error('parseVerifyVerdict: 不是 JSON 对象');
  const hasPass = typeof raw.pass === 'boolean';
  const hasIssues = Array.isArray(raw.issues);
  if (!hasPass && !hasIssues) throw new Error('parseVerifyVerdict: 缺 pass/issues');

  const issues = (hasIssues ? raw.issues : [])
    .filter(it => it && typeof it === 'object'
      && typeof it.problem === 'string' && it.problem.trim()
      && typeof it.field === 'string' && it.field.trim())
    .slice(0, 10)
    .map(it => ({ field: it.field.trim(), problem: it.problem.trim() }));

  return { pass: hasPass && raw.pass === true && issues.length === 0, issues };
}
