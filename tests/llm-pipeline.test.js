import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LlmError } from '../app/js/llm/client.js';
import { PIPELINE_BUDGETS, runWordPipeline } from '../app/js/llm/pipeline.js';

const push = fn => fn(); // 测试用无队列直通

const WORD = {
  k: 'aubergine',
  w: 'aubergine',
  senses: [{ guide: 'VEG', pos: 'noun', level: 'B1', def: 'a purple vegetable', ex: ['aubergine curry'] }],
};

const goodZh = '园艺蔬菜里指一种紫色蔬菜，' + '茄'.repeat(120);
const record = ({ zh = goodZh, family = [] } = {}) => JSON.stringify({
  zh,
  family,
  etymology: { origin: '源自希腊语 beringen，经阿拉伯语进入罗曼语。', story: '', path: [] },
});

/** 按 system prompt 分流的假模型：gens/repairs/verifies 是各阶段的响应队列 */
function makeChat({ gens = [], repairs = [], verifies = [] } = {}) {
  const calls = { gen: [], repair: [], verify: [] };
  const chatImpl = async (messages) => {
    const sys = messages[0].content;
    if (sys.includes('数据修复器')) { calls.repair.push(messages); return repairs.shift() ?? '[]'; }
    if (sys.includes('核查员')) { calls.verify.push(messages); return verifies.shift() ?? '{"pass":true,"issues":[]}'; }
    calls.gen.push(messages);
    const next = gens.shift();
    if (next === undefined) throw new Error('gen 队列空');
    return next;
  };
  return { chatImpl, calls };
}

const CFG = { baseUrl: '/llm/v1', model: 'm', apiKey: 'k' };

test('首轮本地合格 + skipVerify → 一次调用产出', async () => {
  const { chatImpl, calls } = makeChat({ gens: [record({ family: [{ w: 'eggplant', rel: 'sibling', pos: 'noun', zh: '茄子' }] })] });
  const res = await runWordPipeline(WORD, [], { push, genCfg: CFG, skipVerify: true, chatImpl });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.stats.genRounds, 1);
  assert.equal(res.stats.calls, 1);
  assert.equal(res.data.family[0].w, 'eggplant');
  assert.equal(calls.repair.length, 0, '不该进修复轮');
});

test('family 超 30 → 定向修复压缩，不整词重生成', async () => {
  const bad = { w: 'eggplant', rel: 'sibling', pos: 'noun', zh: '注'.repeat(31) };
  const { chatImpl, calls } = makeChat({
    gens: [record({ family: [bad] })],
    repairs: [JSON.stringify([{ w: 'eggplant', rel: 'sibling', pos: 'noun', zh: '茄子，北美常用' }])],
  });
  const res = await runWordPipeline(WORD, [], { push, genCfg: CFG, skipVerify: true, chatImpl });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.stats.genRounds, 1, '修复成功不该重新生成');
  assert.equal(res.stats.repairs, 1);
  assert.equal(res.data.family.length, 1);
  assert.equal(res.data.family[0].zh, '茄子，北美常用');
  assert.ok(res.data.family[0].zh.length <= 30);
  assert.equal(calls.gen.length, 1);
});

test('修复输出省略修不了的条目 → 接受缺失（family 变空但产出）', async () => {
  const bad = { w: 'eggplant', rel: 'sibling', pos: 'noun', zh: '注'.repeat(31) };
  const { chatImpl } = makeChat({ gens: [record({ family: [bad] })], repairs: ['[]'] });
  const res = await runWordPipeline(WORD, [], { push, genCfg: CFG, skipVerify: true, chatImpl });
  assert.equal(res.ok, true, res.error);
  assert.deepEqual(res.data.family, []);
  assert.equal(res.stats.repairs, 1);
});

test('修复仍超长 → 预算尽后降级整词重生成，反馈带原因', async () => {
  const bad = { w: 'eggplant', rel: 'sibling', pos: 'noun', zh: '注'.repeat(31) };
  const { chatImpl, calls } = makeChat({
    gens: [record({ family: [bad] }), record({ family: [{ w: 'eggplant', rel: 'sibling', pos: 'noun', zh: '茄子' }] })],
    repairs: [JSON.stringify([{ w: 'eggplant', rel: 'sibling', pos: 'noun', zh: '注'.repeat(31) }])],
  });
  const res = await runWordPipeline(WORD, [], { push, genCfg: CFG, skipVerify: true, budgets: { repairs: 1 }, chatImpl });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.stats.genRounds, 2);
  assert.equal(res.stats.repairs, 1);
  const second = calls.gen[1];
  const lastMsg = second[second.length - 1];
  assert.equal(lastMsg.role, 'user');
  assert.match(lastMsg.content, /超长/, '反馈清单要带超长原因');
});

test('致命问题（zh 过短）→ 带清单重生成', async () => {
  const { chatImpl, calls } = makeChat({ gens: [record({ zh: '太短' }), record()] });
  const res = await runWordPipeline(WORD, [], { push, genCfg: CFG, skipVerify: true, chatImpl });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.stats.genRounds, 2);
  const second = calls.gen[1];
  assert.match(second[second.length - 1].content, /过短/);
  assert.equal(second[second.length - 2].role, 'assistant', '带上一版输出当上下文');
});

test('核查不过 → 带 issues 重生成 → 第二次通过', async () => {
  const { chatImpl, calls } = makeChat({
    gens: [record(), record()],
    verifies: [
      JSON.stringify({ pass: false, issues: [{ field: 'family[0].zh', problem: '注释与词不对应' }] }),
      '{"pass":true,"issues":[]}',
    ],
  });
  const res = await runWordPipeline(WORD, [], { push, genCfg: CFG, verifyCfg: { ...CFG, model: 'v2' }, chatImpl });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.stats.verifyRounds, 2);
  assert.equal(res.stats.genRounds, 2);
  const secondGen = calls.gen[1];
  assert.match(secondGen[secondGen.length - 1].content, /family\[0\]\.zh/);
  assert.equal(calls.verify[0][0].content.includes('牛B词典'), false, '核查员不拿生成 prompt');
});

test('核查预算用尽 → ok:false，rounds 带完整轨迹', async () => {
  const { chatImpl } = makeChat({
    gens: [record(), record()],
    verifies: [
      '{"pass":false,"issues":[{"field":"zh","problem":"编造义项"}]}',
      '{"pass":false,"issues":[{"field":"etymology.origin","problem":"语种存疑"}]}',
    ],
  });
  const res = await runWordPipeline(WORD, [], { push, genCfg: CFG, chatImpl });
  assert.equal(res.ok, false);
  assert.match(res.error, /核查不通过/);
  assert.match(res.error, /语种存疑/, 'error 汇报最后一轮的 issues');
  const verifies = res.rounds.filter(r => r.stage === 'verify');
  assert.equal(verifies.length, 2);
  assert.match(verifies[0].issues[0].problem, /编造义项/, '首轮 issues 留在轨迹里');
  assert.equal(res.verifyIssues.length, 1, 'verifyIssues = 最后一轮的 issues');
});

test('gen 预算用尽 → ok:false 且带最后的问题清单', async () => {
  const { chatImpl } = makeChat({ gens: [record({ zh: '太短' }), record({ zh: '也短' }), record({ zh: '还短' })] });
  const res = await runWordPipeline(WORD, [], { push, genCfg: CFG, skipVerify: true, chatImpl });
  assert.equal(res.ok, false);
  assert.equal(res.stats.genRounds, PIPELINE_BUDGETS.genRounds);
  assert.match(res.error, /过短/);
  assert.equal(res.rounds.filter(r => r.stage === 'gen').length, 3);
});

test('NETWORK 错误直接抛出（服务没开，重试无意义）', async () => {
  const chatImpl = async () => { throw new LlmError('代理不通', 'NETWORK'); };
  await assert.rejects(
    () => runWordPipeline(WORD, [], { push, genCfg: CFG, skipVerify: true, chatImpl }),
    err => err.code === 'NETWORK',
  );
});

test('事件流：round/call/result/checked/done 顺序齐全', async () => {
  const { chatImpl } = makeChat({ gens: [record()] });
  const events = [];
  await runWordPipeline(WORD, [], { push, genCfg: CFG, skipVerify: true, chatImpl, onEvent: e => events.push(e) });
  const types = events.map(e => e.type);
  assert.ok(types.includes('round'));
  assert.ok(types.includes('call'));
  assert.ok(types.includes('result'));
  assert.ok(types.includes('checked'));
  assert.equal(types[types.length - 1], 'done');
  const done = events[events.length - 1];
  assert.equal(done.ok, true);
  assert.equal(done.stats.calls, 1);
});
