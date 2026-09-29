import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createQueue, DEFAULT_MIN_INTERVAL } from '../app/js/llm/ratelimit.js';

/** 假时钟：sleep 直接把 now 推进，测试零真实等待 */
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async ms => { t += ms; },
    get time() { return t; },
  };
}

test('默认间隔是 6500ms（RPM 10 留余量）', () => {
  assert.equal(DEFAULT_MIN_INTERVAL, 6500);
});

test('连续三次调用的发起间隔 ≥ 最小间隔', async () => {
  const clock = fakeClock();
  const push = createQueue({ minIntervalMs: 6500, now: clock.now, sleep: clock.sleep });
  const starts = [];

  const job = () => { starts.push(clock.time); return starts.length; };

  assert.equal(await push(job), 1);
  assert.equal(await push(job), 2);
  assert.equal(await push(job), 3);

  assert.deepEqual(starts, [0, 6500, 13000]);
  assert.ok(starts[1] - starts[0] >= 6500);
  assert.ok(starts[2] - starts[1] >= 6500);
});

test('间隔不足时补睡，超出时不睡', async () => {
  const clock = fakeClock();
  const push = createQueue({ minIntervalMs: 6500, now: clock.now, sleep: clock.sleep });

  await push(() => 'first');
  // 手动推进 10 秒（已超间隔），下一次不该再等
  await clock.sleep(10000);
  const before = clock.time;
  await push(() => 'ok');
  assert.equal(clock.time, before, '已超间隔不应补睡');
});

test('任务串行：前一个 settle 后才轮到下一个', async () => {
  const clock = fakeClock();
  const push = createQueue({ minIntervalMs: 0, now: clock.now, sleep: clock.sleep });
  const log = [];

  const slow = () => new Promise(resolve => {
    log.push('slow-start');
    setTimeout(() => { log.push('slow-end'); resolve(1); }, 20);
  });

  const p1 = push(slow);
  const p2 = push(() => { log.push('next'); return 2; });
  await Promise.all([p1, p2]);

  assert.deepEqual(log, ['slow-start', 'slow-end', 'next']);
});

test('任务抛错不卡队列，错误抛给调用方', async () => {
  const clock = fakeClock();
  const push = createQueue({ minIntervalMs: 0, now: clock.now, sleep: clock.sleep });

  await assert.rejects(push(() => { throw new Error('boom'); }), /boom/);
  assert.equal(await push(() => 'recovered'), 'recovered');
});

test('多个 push 同时挂上时仍严格串行', async () => {
  const clock = fakeClock();
  const push = createQueue({ minIntervalMs: 100, now: clock.now, sleep: clock.sleep });
  const order = [];

  const make = id => () => new Promise(resolve => {
    order.push(`start${id}`);
    setTimeout(() => { order.push(`end${id}`); resolve(id); }, 5);
  });

  const results = await Promise.all([push(make(1)), push(make(2)), push(make(3))]);
  assert.deepEqual(results, [1, 2, 3]);
  assert.deepEqual(order, ['start1', 'end1', 'start2', 'end2', 'start3', 'end3']);
});
