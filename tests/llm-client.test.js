import assert from 'node:assert/strict';
import { test } from 'node:test';

import { chat, DEFAULT_CFG, ERR, LlmError } from '../app/js/llm/client.js';

/** 造一个 Response 形状的对象（Node 24 也有全局 Response，这里手搓更可控） */
function resp(status, bodyObj, { text } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (text !== undefined ? text : JSON.stringify(bodyObj)),
  };
}

function okChat(content, { finish_reason = 'stop' } = {}) {
  return resp(200, { choices: [{ finish_reason, message: { content } }] });
}

function recordingFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return handler(calls.length, { url, init });
  };
  fn.calls = calls;
  return fn;
}

const noSleep = async () => {};

test('默认配置指向同源反代与本地模型', () => {
  assert.equal(DEFAULT_CFG.baseUrl, '/llm/v1');
  assert.equal(DEFAULT_CFG.model, 'agnes-3.0-flash');
  assert.equal(DEFAULT_CFG.apiKey, 'PROXY_MANAGED');
});

test('200 正常返回 content，URL/model/messages 组装正确', async () => {
  const f = recordingFetch(() => okChat('{"ok":true}'));
  const out = await chat(
    [{ role: 'user', content: 'hi' }],
    { baseUrl: 'http://x/v1', model: 'm1', apiKey: 'k1' },
    { fetch: f, sleep: noSleep },
  );
  assert.equal(out, '{"ok":true}');
  assert.equal(f.calls[0].url, 'http://x/v1/chat/completions');
  assert.equal(f.calls[0].body.model, 'm1');
  assert.deepEqual(f.calls[0].body.messages, [{ role: 'user', content: 'hi' }]);
  assert.equal(f.calls[0].init.headers.Authorization, 'Bearer k1');
  assert.equal(f.calls[0].body.response_format, undefined, '默认不带 response_format');
});

test('baseUrl 尾斜杠不重复拼接', async () => {
  const f = recordingFetch(() => okChat('ok'));
  await chat([], { baseUrl: 'http://x/v1/' }, { fetch: f, sleep: noSleep });
  assert.equal(f.calls[0].url, 'http://x/v1/chat/completions');
});

test('json:true 带 response_format json_object', async () => {
  const f = recordingFetch(() => okChat('{}'));
  await chat([], { baseUrl: 'http://x/v1' }, { fetch: f, sleep: noSleep, json: true });
  assert.deepEqual(f.calls[0].body.response_format, { type: 'json_object' });
});

test('401 分级为 AUTH 且不重试', async () => {
  const f = recordingFetch(() => resp(401, null, { text: 'bad key' }));
  await assert.rejects(
    chat([], { baseUrl: 'http://x/v1' }, { fetch: f, sleep: noSleep }),
    err => err instanceof LlmError && err.code === ERR.AUTH && /401/.test(err.message),
  );
  assert.equal(f.calls.length, 1);
});

test('429 退避补试一次后成功', async () => {
  let slept = 0;
  const sleep = async ms => { slept += ms; };
  const f = recordingFetch(n => (n === 1 ? resp(429, null, { text: 'slow down' }) : okChat('retry-ok')));

  const out = await chat([], { baseUrl: 'http://x/v1' }, { fetch: f, sleep });
  assert.equal(out, 'retry-ok');
  assert.equal(f.calls.length, 2);
  assert.ok(slept >= 3000, '429 至少退避 3 秒');
});

test('持续 429 补试用尽后抛 RATE', async () => {
  const f = recordingFetch(() => resp(429, null, { text: 'nope' }));
  await assert.rejects(
    chat([], { baseUrl: 'http://x/v1' }, { fetch: f, sleep: noSleep }),
    err => err.code === ERR.RATE,
  );
  assert.equal(f.calls.length, 2, '默认 retries=1 → 共 2 次');
});

test('500 分级为 UPSTREAM 且不重试', async () => {
  const f = recordingFetch(() => resp(500, null, { text: 'oops' }));
  await assert.rejects(
    chat([], { baseUrl: 'http://x/v1' }, { fetch: f, sleep: noSleep }),
    err => err.code === ERR.UPSTREAM,
  );
  assert.equal(f.calls.length, 1);
});

test('网络异常分级为 NETWORK 并带反代提示', async () => {
  const f = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(
    chat([], { baseUrl: 'http://x/v1' }, { fetch: f, sleep: noSleep }),
    err => err.code === ERR.NETWORK && /CORS/.test(err.message) && /反代/.test(err.message),
  );
});

test('finish_reason=length 报截断', async () => {
  const f = recordingFetch(() => okChat('{"zh":"半', { finish_reason: 'length' }));
  await assert.rejects(
    chat([], { baseUrl: 'http://x/v1' }, { fetch: f, sleep: noSleep }),
    err => err.code === ERR.TRUNCATED,
  );
});

test('空 content 报 EMPTY', async () => {
  const f = recordingFetch(() => okChat(''));
  await assert.rejects(
    chat([], { baseUrl: 'http://x/v1' }, { fetch: f, sleep: noSleep }),
    err => err.code === ERR.EMPTY,
  );
});

test('响应不是 JSON 报 UPSTREAM', async () => {
  const f = recordingFetch(() => resp(200, null, { text: '<html>502</html>' }));
  await assert.rejects(
    chat([], { baseUrl: 'http://x/v1' }, { fetch: f, sleep: noSleep }),
    err => err.code === ERR.UPSTREAM,
  );
});

test('超时抛 TIMEOUT（不依赖 AbortController）', async () => {
  const hanging = () => new Promise(() => {}); // 永不 settle
  await assert.rejects(
    chat([], { baseUrl: 'http://x/v1' }, { fetch: hanging, sleep: noSleep, timeoutMs: 30 }),
    err => err.code === ERR.TIMEOUT,
  );
});

test('缺 baseUrl 抛 AUTH 级配置错', async () => {
  await assert.rejects(
    chat([], { baseUrl: '' }, { fetch: recordingFetch(() => okChat('x')), sleep: noSleep }),
    err => err.code === ERR.AUTH,
  );
});
