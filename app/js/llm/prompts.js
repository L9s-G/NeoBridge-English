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
