import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeAudit, selectPending } from '../scripts/audit-ext.mjs';

const W = (k, verdict, extra = {}) => ({ k, w: k, verdict, issues: [], ...extra });

test('mergeAudit：顺序对齐源，本轮结果覆盖旧 verdict', () => {
  const prev = [W('a', 'pass'), W('b', 'fail', { issues: [{ field: 'zh', problem: '旧问题' }] })];
  const next = [W('b', 'pass'), W('c', 'fail')];
  const merged = mergeAudit(prev, next, ['a', 'b', 'c']);
  assert.deepEqual(merged.map(e => [e.k, e.verdict]), [['a', 'pass'], ['b', 'pass'], ['c', 'fail']]);
  assert.equal(merged[1].issues.length, 0); // 被本轮结果覆盖，不残留旧 issues
});

test('mergeAudit：源里已删的旧条目丢弃（audit 永远对齐数据本体）', () => {
  const prev = [W('a', 'pass'), W('gone', 'fail')];
  const merged = mergeAudit(prev, [], ['a']);
  assert.deepEqual(merged.map(e => e.k), ['a']);
});

test('selectPending：pass/fail 跳过，error 与缺失重跑，--force 全跑', () => {
  const targets = [{ k: 'a' }, { k: 'b' }, { k: 'c' }, { k: 'd' }];
  const prev = [W('a', 'pass'), W('b', 'fail'), W('c', 'error')];
  assert.deepEqual(selectPending(targets, prev, false).map(w => w.k), ['c', 'd']);
  assert.deepEqual(selectPending(targets, prev, true).map(w => w.k), ['a', 'b', 'c', 'd']);
  assert.deepEqual(selectPending(targets, [], false).map(w => w.k), ['a', 'b', 'c', 'd']);
});

test('selectPending：auditV 变更由调用方丢弃旧数据后等价于空断点', () => {
  const targets = [{ k: 'a' }];
  assert.deepEqual(selectPending(targets, [], false).map(w => w.k), ['a']);
});
