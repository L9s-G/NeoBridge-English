/**
 * ext-loader 的纯函数行动表（decideExt）——IO 部分靠冒烟验证，
 * 这里盯住"什么情况下联网 / 什么情况下吃缓存 / 什么情况下认输"。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decideExt } from '../app/js/db/ext-loader.js';

test('两头都没有 sha → unavailable（无网首次安装，UI 整块隐藏）', () => {
  assert.deepEqual(
    decideExt({ manifestSha: null, storedSha: null, hasBody: false }),
    { action: 'unavailable', sha: null },
  );
});

test('新 sha == 本地 sha 且正文在 → use-cache（发版后没改 ext，零流量）', () => {
  assert.deepEqual(
    decideExt({ manifestSha: 'aaa', storedSha: 'aaa', hasBody: true }),
    { action: 'use-cache', sha: 'aaa' },
  );
});

test('manifest 拿不到（离线）但本地 meta + 正文在 → use-cache 用旧 sha', () => {
  assert.deepEqual(
    decideExt({ manifestSha: null, storedSha: 'old', hasBody: true }),
    { action: 'use-cache', sha: 'old' },
  );
});

test('新 sha 落后不了——sha 变了但正文在 → refresh 拉新', () => {
  assert.deepEqual(
    decideExt({ manifestSha: 'bbb', storedSha: 'aaa', hasBody: true }),
    { action: 'refresh', sha: 'bbb' },
  );
});

test('正文丢了但 meta 还在（写一半断电）→ fetch 重拉', () => {
  assert.deepEqual(
    decideExt({ manifestSha: 'aaa', storedSha: 'aaa', hasBody: false }),
    { action: 'fetch', sha: 'aaa' },
  );
  assert.deepEqual(
    decideExt({ manifestSha: null, storedSha: 'old', hasBody: false }),
    { action: 'fetch', sha: 'old' },
  );
});

test('meta 丢了但正文在（同 URL 只信 sha 校验过的新拷贝）→ refresh', () => {
  assert.deepEqual(
    decideExt({ manifestSha: 'bbb', storedSha: null, hasBody: true }),
    { action: 'refresh', sha: 'bbb' },
  );
});
