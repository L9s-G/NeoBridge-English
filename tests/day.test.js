import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dayKey, dayLabel, lastDays, relDay } from '../app/js/core/day.js';

/** 构造本地时间戳，避免测试受时区影响 */
const local = (y, m, d, h = 12) => new Date(y, m - 1, d, h).getTime();

test('dayKey 用本地时区', () => {
  assert.equal(dayKey(local(2026, 9, 28)), '2026-09-28');
  assert.equal(dayKey(local(2026, 1, 5, 0)), '2026-01-05');
  assert.equal(dayKey(local(2026, 12, 31, 23)), '2026-12-31');
});

test('lastDays 返回最近 n 天，从旧到新，末尾是今天', () => {
  const days = lastDays(7, local(2026, 9, 28));
  assert.equal(days.length, 7);
  assert.equal(days[0], '2026-09-22');
  assert.equal(days[6], '2026-09-28');
  assert.deepEqual(new Set(days).size, 7, '没有重复');
});

test('lastDays 跨月、跨年正确', () => {
  assert.equal(lastDays(3, local(2026, 3, 1))[0], '2026-02-27');
  assert.equal(lastDays(2, local(2026, 1, 1))[0], '2025-12-31');
  assert.equal(lastDays(5, local(2024, 3, 1))[0], '2024-02-26', '闰年');
});

test('dayLabel 只做展示，按字符串拆解不受时区影响', () => {
  assert.equal(dayLabel('2026-09-28'), '9月28日 周一');
  assert.equal(dayLabel('2026-01-01'), '1月1日 周四');
});

test('relDay：今天 / 昨天 / N 天前', () => {
  const now = local(2026, 9, 28, 20);
  assert.equal(relDay(local(2026, 9, 28, 9), now), '今天');
  assert.equal(relDay(local(2026, 9, 27, 23), now), '昨天');
  assert.equal(relDay(local(2026, 9, 22), now), '6 天前');
  assert.equal(relDay(null, now), '');
});
