/**
 * 答题卡派生信息的纯逻辑校验 —— 不碰 DOM，直接跑真实的 app/data/。
 * 与 importer.test.js 同一思路：构造用例验规则，真实词包验分布。
 *
 * ⚠ 里面写死的卡数（389 / 1299 / 244）依赖 manifest.json 指向的那份词包，
 *   换词包后若失败，先确认是显示规则变了还是数据变了，再改数字。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  POS_ZH,
  distinctPos,
  keywordText,
  lenClass,
  posTitle,
  senseUrl,
  showGrouping,
  youglishUrl,
} from '../app/js/ui/card-info.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA = join(ROOT, 'app', 'data');
const manifest = JSON.parse(readFileSync(join(DATA, 'manifest.json'), 'utf8'));
const pack = JSON.parse(readFileSync(join(DATA, manifest.file), 'utf8'));
const WORDS = pack.words;
const find = w => {
  const hit = WORDS.find(x => x.w === w);
  assert.ok(hit, `词包里应有 ${JSON.stringify(w)}`);
  return hit;
};

/* ---------------- POS_ZH ---------------- */

test('真实词包里出现过的每种词性都有中文', () => {
  const used = new Set();
  for (const word of WORDS) for (const s of word.senses) if (s.pos) used.add(s.pos);

  const missing = [...used].filter(p => !POS_ZH[p]);
  assert.deepEqual(missing, [], '这些词性缺中文映射');
  assert.equal(Object.keys(POS_ZH).length, 14, '共 14 种词性');
  for (const p of used) assert.notEqual(posTitle(p), 'undefined');
});

test('posTitle：已知给中文，未知原样返回', () => {
  assert.equal(posTitle('noun'), '名词');
  assert.equal(posTitle('phrasal verb'), '短语动词');
  assert.equal(posTitle('made-up'), 'made-up');
  assert.equal(posTitle(''), '');
  assert.equal(posTitle(null), '');
});

/* ---------------- distinctPos / showGrouping ---------------- */

const wordOf = (w, senses) => ({ w, senses });

test('distinctPos 去重保序，空义项不炸', () => {
  const w = wordOf('x', [{ pos: 'noun' }, { pos: 'verb' }, { pos: 'noun' }, {}]);
  assert.deepEqual(distinctPos(w), ['noun', 'verb']);
  assert.deepEqual(distinctPos(wordOf('x', [])), []);
  assert.deepEqual(distinctPos(null), []);
});

test('showGrouping 只对混合词性为真', () => {
  assert.equal(showGrouping(wordOf('x', [{ pos: 'noun' }, { pos: 'verb' }])), true);
  assert.equal(showGrouping(wordOf('x', [{ pos: 'phrase' }])), false);
  assert.equal(showGrouping(wordOf('x', [{ pos: 'noun' }, { pos: 'noun' }])), false);
});

test('真实词包：恰好 389 张混合词性卡需要分组', () => {
  const grouped = WORDS.filter(showGrouping);
  assert.equal(grouped.length, 389);

  const kinds = grouped.map(w => distinctPos(w).sort().join('+'));
  assert.equal(kinds.filter(k => k === 'noun+verb').length, 258, 'noun+verb 是最大宗');
});

/* ---------------- lenClass ---------------- */

test('lenClass 按词长分 4 档，边界含左不含右', () => {
  assert.equal(lenClass(wordOf('cat')), 'len-s');
  assert.equal(lenClass(wordOf('abcdef')), 'len-s', '6 仍是 len-s');
  assert.equal(lenClass(wordOf('abcdefg')), 'len-m', '7 进 len-m');
  assert.equal(lenClass(wordOf('abcdefghijkl')), 'len-m', '12 仍是 len-m');
  assert.equal(lenClass(wordOf('abcdefghijklm')), 'len-l', '13 进 len-l');
  assert.equal(lenClass(wordOf('abcdefghijklmnopqrst')), 'len-l', '20 仍是 len-l');
  assert.equal(lenClass(wordOf('abcdefghijklmnopqrstu')), 'len-xl', '21 进 len-xl');
  assert.equal(lenClass(wordOf('')), 'len-s', '空词兜底');
  assert.equal(lenClass(null), 'len-s', 'null 兜底');
});

test('真实词包：四档都有卡，且长词卡确实落进 len-xl', () => {
  const counts = { 'len-s': 0, 'len-m': 0, 'len-l': 0, 'len-xl': 0 };
  for (const w of WORDS) counts[lenClass(w)] += 1;
  assert.deepEqual(counts, { 'len-s': 1770, 'len-m': 2276, 'len-l': 510, 'len-xl': 452 });

  assert.equal(lenClass(find('the weekend/week/Thursday, etc. after next')), 'len-xl');
});

/* ---------------- keywordText ---------------- */

test('keywordText：词头与主词相同则不输出，去重保序', () => {
  assert.deepEqual(keywordText(wordOf('account', [{ hw: 'account' }])), [], '纯单词不渲染该行');
  assert.deepEqual(
    keywordText(wordOf('X', [{ hw: 'on' }, { hw: 'own' }, { hw: 'on' }])),
    ['on', 'own'],
    '保序且去重',
  );
  assert.deepEqual(keywordText(wordOf('x', [{ hw: 'x' }])), [], '大小写/空白不敏感');
  assert.deepEqual(keywordText(wordOf('x', [{ hw: '  x  ' }])), []);
  assert.deepEqual(keywordText(null), []);
});

test('keywordText：真实代表卡', () => {
  assert.deepEqual(keywordText(find('account')), [], '纯单词无 Keyword 行');
  assert.deepEqual(keywordText(find('tear')), [], '同形异义词 hw===w，同样不渲染');
  assert.deepEqual(keywordText(find('lie')), []);
  assert.deepEqual(keywordText(find('take off')), ['take']);
  assert.deepEqual(keywordText(find('(all) on your own')), ['on', 'own']);
  assert.deepEqual(keywordText(find('the weekend/week/Thursday, etc. after next')), ['next']);
});

test('真实词包：Keyword 行只在 1299 张含短语类卡上出现', () => {
  const show = WORDS.filter(w => keywordText(w).length > 0);
  assert.equal(show.length, 1299, '含 phrase / phrasal verb 的卡');

  const MULTI = ['phrase', 'phrasal verb'];
  const phraseCards = WORDS.filter(w => w.senses.some(s => MULTI.includes(s.pos)));
  assert.equal(show.length, phraseCards.length, '恰好等于含短语类的卡数');
});

test('真实词包：显示 Keyword 行的卡，词头 refid 无歧义', () => {
  let ambiguous = 0;
  for (const w of WORDS.filter(w => keywordText(w).length > 0)) {
    const byHw = new Map();
    for (const s of w.senses) {
      if (!byHw.has(s.hw)) byHw.set(s.hw, new Set());
      byHw.get(s.hw).add(s.refid);
    }
    for (const ids of byHw.values()) if (ids.size > 1) ambiguous += 1;
  }
  assert.equal(ambiguous, 0, '同一词头不能指向多个 refid，否则链接取值有歧义');
});

/* ---------------- youglishUrl / senseUrl ---------------- */

test('youglishUrl：英式口音、空格与斜杠都正确编码', () => {
  assert.equal(youglishUrl(wordOf('account')), 'https://youglish.com/pronounce/account/english/uk');
  assert.equal(
    youglishUrl(wordOf('take off')),
    'https://youglish.com/pronounce/take%20off/english/uk',
  );
  assert.equal(
    youglishUrl(find('the weekend/week/Thursday, etc. after next')),
    `https://youglish.com/pronounce/${encodeURIComponent('the weekend/week/Thursday, etc. after next')}/english/uk`,
  );
  assert.equal(youglishUrl(null), 'https://youglish.com/pronounce//english/uk');
});

test('senseUrl：baseUrl 已含 refid 参数，直接拼义项 refid', () => {
  const url = 'https://englishprofile.org/?menu=evp-online&refid=';
  assert.equal(senseUrl(url, { refid: 'ID_00000045' }), `${url}ID_00000045`);
  assert.equal(senseUrl('', { refid: 'ID_1' }), 'ID_1');
  assert.equal(senseUrl(url, {}), url, '缺 refid 不炸');
  assert.equal(senseUrl(null, null), '');
});

test('真实词包：义项级链接覆盖全部 244 张多词条卡', () => {
  const multi = WORDS.filter(w => (w.entries || []).length > 1);
  assert.equal(multi.length, 244);

  let uncovered = 0;
  for (const w of multi) {
    const linked = new Set(w.senses.map(s => s.refid));
    if (w.entries.some(id => !linked.has(id))) uncovered += 1;
  }
  assert.equal(uncovered, 0, '每个 entries[i] 都必须能被某个义项的详情链接命中');
});

test('真实词包：多词条卡里 241 张有 Keyword 行，3 张靠义项链接兜底', () => {
  const multi = WORDS.filter(w => (w.entries || []).length > 1);
  assert.equal(multi.filter(w => keywordText(w).length > 0).length, 241);
  assert.equal(
    multi.filter(w => keywordText(w).length === 0).length,
    3,
    'lie / row / tear —— hw===w，只能靠背面的义项详情链接',
  );
});

/* ---------------- baseUrl 与词包一致 ---------------- */

test('baseUrl 与词包里的值一致', () => {
  assert.equal(pack.baseUrl, 'https://englishprofile.org/?menu=evp-online&refid=');
});
