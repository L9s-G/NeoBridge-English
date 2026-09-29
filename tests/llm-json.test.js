import assert from 'node:assert/strict';
import { test } from 'node:test';

import { extractJson } from '../app/js/llm/json.js';

test('纯 JSON 原样解析', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
});

test('剥 ```json 围栏', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
});

test('剥无语言标注的围栏', () => {
  assert.deepEqual(extractJson('```\n{"a":1}\n```'), { a: 1 });
});

test('跳过 JSON 前后的解释文字', () => {
  const out = extractJson('好的，以下是结果：\n{"zh":"释义"}\n希望有帮助！');
  assert.deepEqual(out, { zh: '释义' });
});

test('字符串内的括号不参与平衡', () => {
  const out = extractJson('{"s":"a { b } c","n":2}');
  assert.deepEqual(out, { s: 'a { b } c', n: 2 });
});

test('转义引号不破坏字符串状态', () => {
  const out = extractJson('{"s":"say \\"hi\\" {x}"}');
  assert.equal(out.s, 'say "hi" {x}');
});

test('数组也能取', () => {
  assert.deepEqual(extractJson('[1,2,3]'), [1, 2, 3]);
});

test('截断的 JSON 抛"未闭合"错', () => {
  assert.throws(() => extractJson('{"zh":"半截输出……'), /未闭合/);
});

test('空输入抛错', () => {
  assert.throws(() => extractJson(''), /输入为空/);
  assert.throws(() => extractJson('   '), /输入为空/);
  assert.throws(() => extractJson(null), /输入为空/);
});

test('完全没有 JSON 的文本抛错', () => {
  assert.throws(() => extractJson('我觉得这个词很有意思'), /找不到 JSON 起始符/);
});
