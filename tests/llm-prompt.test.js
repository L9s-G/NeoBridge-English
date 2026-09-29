import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildWordExtPrompt, FAMILY_POS, parseWordExt, PROMPT_VERSION } from '../app/js/llm/prompts.js';
import { validateWordExt } from '../app/js/llm/validate.js';

const ACCOUNT = {
  k: 'account',
  w: 'account',
  senses: [
    { guide: 'BANK', pos: 'noun', level: 'B1', def: 'an arrangement with a bank...', ex: ['I opened an account.'] },
    { guide: 'REPORT', pos: 'noun', level: 'B2', def: 'a written description...', ex: ['She gave an account.'] },
  ],
};

const GOOD = {
  zh: 'account 最核心的意思是"银行账户"，指你在银行开户用来存取款的安排，常用搭配有 open/close an account、current account、on account of。'
    + '第二个常见义项是"描述、叙述"，指对已发生事情的书面或口头说明，如 give an account of、a thrilling account。'
    + '作动词时它表示"认为、把……归因于"，常与 to/for 搭配，account for 既是"解释"也是"占比"，'
    + '考试里最容易混的就是这一组。别把它和 accountant 搞混——一个是账，一个是人。',
  family: [
    { w: 'accountant', rel: 'derived', pos: 'noun', zh: '会计人员，审计员' },
    { w: 'accounting', rel: 'derived', pos: 'noun', zh: '会计学，账目' },
    { w: 'count', rel: 'sibling', pos: 'verb', zh: '数，计数' },
  ],
  etymology: {
    origin: '源自拉丁语 computare（计算），经古法语进入中古英语。',
    story: '这个词最早来自拉丁语 computare，本义是"清点、计算"。进入古法语后变成 conter / aconter，'
      + '指"叙述、讲述"——古人记账靠嘴说，算完了还要讲一遍。中古英语沿袭了这层"账目"与"叙述"双重含义，'
      + '到 17 世纪固定为现代的"账户"义项。有意思的是，"计算"这条线被 count 抢走了，account 反而把重心'
      + '挪到了钱和责任上，account for（解释、占比）正是"把账算清楚"的现代遗存。',
    path: [
      { form: 'computare', lang: 'Latin', meaning: '计算' },
      { form: 'aconter', lang: 'Old French', meaning: '叙述，记账' },
      { form: 'account', lang: 'Middle English', meaning: '账目，说明' },
    ],
  },
};

test('PROMPT_VERSION 是整数（缓存键用）', () => {
  assert.equal(typeof PROMPT_VERSION, 'number');
});

test('buildWordExtPrompt：system+user 两轮，注入官方义项与短语家族', () => {
  const msgs = buildWordExtPrompt(ACCOUNT, ['take into account', 'on account of']);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, 'system');
  assert.equal(msgs[1].role, 'user');
  assert.match(msgs[1].content, /account/);
  assert.match(msgs[1].content, /BANK/);           // 义项指引进了 prompt
  assert.match(msgs[1].content, /take into account/); // 短语家族进了 prompt
  assert.match(msgs[1].content, /场景关键字/);        // guide 场景化措辞
});

test('system prompt：可选项显式声明不硬拗 + 场景关键字', () => {
  const sys = buildWordExtPrompt(ACCOUNT, [])[0].content;
  assert.match(sys, /宁可为空/);         // family/story 空值合法
  assert.match(sys, /键缺一不可/);        // 顶层键必须在
  assert.match(sys, /场景关键字/);        // guide 是场景关键字
  assert.match(sys, /200~500字/);         // zh 字数约定未动
});

test('FAMILY_POS 12 种（去掉 phrase / phrasal verb：非单 token）', () => {
  assert.equal(FAMILY_POS.length, 12);
  assert.ok(!FAMILY_POS.includes('phrase'));
  assert.ok(!FAMILY_POS.includes('phrasal verb'));
});

test('parseWordExt：合法输出原样取三段', () => {
  const out = parseWordExt(JSON.stringify(GOOD));
  assert.equal(out.zh, GOOD.zh);
  assert.equal(out.family.length, 3);
  assert.equal(out.etymology.path.length, 3);
});

test('parseWordExt：围栏+杂文也能解析', () => {
  const out = parseWordExt(`好的：\n\`\`\`json\n${JSON.stringify(GOOD)}\n\`\`\``);
  assert.equal(out.family.length, 3);
});

test('parseWordExt：缺 zh / 缺 family 键 / 缺 etymology 抛错', () => {
  const noZh = { ...GOOD, zh: '' };
  assert.throws(() => parseWordExt(JSON.stringify(noZh)), /缺 zh/);
  const noFam = { ...GOOD }; delete noFam.family;
  assert.throws(() => parseWordExt(JSON.stringify(noFam)), /缺 family/);
  const noEt = { ...GOOD }; delete noEt.etymology;
  assert.throws(() => parseWordExt(JSON.stringify(noEt)), /缺 etymology/);
});

test('parseWordExt：story 缺失 → ""（可选项不触发重试）', () => {
  const noStory = JSON.parse(JSON.stringify(GOOD));
  delete noStory.etymology.story;
  const out = parseWordExt(JSON.stringify(noStory));
  assert.equal(out.etymology.story, '');
  const empty = JSON.parse(JSON.stringify(GOOD));
  empty.etymology.story = '';
  assert.equal(parseWordExt(JSON.stringify(empty)).etymology.story, '');
});

test('parseWordExt：family 空数组合法（键在内容可空）', () => {
  const none = JSON.parse(JSON.stringify(GOOD));
  none.family = [];
  assert.deepEqual(parseWordExt(JSON.stringify(none)).family, []);
});

test('validateWordExt：合格输入 ok=true 且原样清洗', () => {
  const r = validateWordExt(JSON.parse(JSON.stringify(GOOD)), 'account');
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.deepEqual(r.errors, []);
  assert.equal(r.cleaned.family.length, 3);
  assert.equal(r.dropped.length, 0);
});

test('validateWordExt：zh 过短 / 无中文 → 整条不合格', () => {
  const short = { ...GOOD, zh: '账户' };
  const r1 = validateWordExt(short, 'account');
  assert.equal(r1.ok, false);
  assert.ok(r1.errors.some(e => /zh 过短/.test(e)));

  const noCn = { ...GOOD, zh: 'This is an English gloss that is long enough but not Chinese at all, '.repeat(2) };
  const r2 = validateWordExt(noCn, 'account');
  assert.equal(r2.ok, false);
  assert.ok(r2.errors.some(e => /不含中文/.test(e)));
});

test('validateWordExt：story 空串 → 合法（可选项），非空才查长度', () => {
  const none = JSON.parse(JSON.stringify(GOOD));
  none.etymology.story = '';
  const r = validateWordExt(none, 'account');
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.equal(r.cleaned.etymology.story, '');

  const tooShort = JSON.parse(JSON.stringify(GOOD));
  tooShort.etymology.story = '来自拉丁语。';
  const r2 = validateWordExt(tooShort, 'account');
  assert.equal(r2.ok, false);
  assert.ok(r2.errors.some(e => /story 过短/.test(e)));
});

test('validateWordExt：family 空数组 → 合法', () => {
  const none = JSON.parse(JSON.stringify(GOOD));
  none.family = [];
  const r = validateWordExt(none, 'account');
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.deepEqual(r.cleaned.family, []);
});

test('validateWordExt：Markdown 装饰符号被剥掉（不触发重试）', () => {
  const md = JSON.parse(JSON.stringify(GOOD));
  md.zh = `**${md.zh}**`;
  md.etymology.story = `**${md.etymology.story}**`;
  const r = validateWordExt(md, 'account');
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.ok(!/\*\*/.test(r.cleaned.zh));
  assert.ok(!/\*\*/.test(r.cleaned.etymology.story));
  assert.equal(r.cleaned.zh, GOOD.zh, '只剥符号不动正文');
});

test('validateWordExt：family 项的自标注（应删/无关）整条剔除', () => {
  const bad = JSON.parse(JSON.stringify(GOOD));
  bad.family.push({ w: 'riboflavin', rel: 'sibling', pos: 'noun', zh: '无关，示例错误，应删' });
  const r = validateWordExt(bad, 'account');
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.equal(r.cleaned.family.length, 3, '自标注项不进产物');
  assert.ok(r.dropped.some(d => d.w === 'riboflavin' && /自标注/.test(d.why)));
});

test('validateWordExt：含 URL → 整条不合格', () => {
  const bad = JSON.parse(JSON.stringify(GOOD));
  bad.etymology.story = `${GOOD.etymology.story}详见 https://example.com/x 这个链接。`;
  const r = validateWordExt(bad, 'account');
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /URL/.test(e)));
});

test('validateWordExt：family 坏项剔除、好项保留（局部清洗不判死刑）', () => {
  const bad = JSON.parse(JSON.stringify(GOOD));
  bad.family.push(
    { w: 'take into account', rel: 'derived', pos: 'verb', zh: '短语混进来了' }, // 非单 token
    { w: 'Account', rel: 'derived', pos: 'noun', zh: '自指' },                     // 与目标词相同
    { w: 'foo', rel: 'cousin', pos: 'noun', zh: 'rel 非法' },                      // rel 非法
    { w: 'bar', rel: 'derived', pos: 'astronaut', zh: 'pos 非法' },                // pos 非法
    { w: 'accountant', rel: 'derived', pos: 'noun', zh: '重复' },                  // 重复
    { w: 'baz', rel: 'derived', pos: 'noun', zh: 'no chinese' },                   // 无中文
  );
  const r = validateWordExt(bad, 'account');
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.equal(r.cleaned.family.length, 3, '只留原 3 个好项');
  assert.equal(r.dropped.length, 6);
  assert.ok(r.dropped.some(d => /单 token/.test(d.why)));
  assert.ok(r.dropped.some(d => /与目标词相同/.test(d.why)));
  assert.ok(r.dropped.some(d => /rel 非法/.test(d.why)));
  assert.ok(r.dropped.some(d => /pos 非法/.test(d.why)));
  assert.ok(r.dropped.some(d => /重复/.test(d.why)));
});

test('validateWordExt：family 截断到 8 项', () => {
  const many = JSON.parse(JSON.stringify(GOOD));
  many.family = [];
  for (let i = 0; i < 15; i += 1) {
    many.family.push({ w: `word${i}`, rel: 'derived', pos: 'noun', zh: `词${i}` });
  }
  const r = validateWordExt(many, 'account');
  assert.equal(r.cleaned.family.length, 8);
});
