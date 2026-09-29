/**
 * OpenAI 兼容 chat/completions 客户端。
 *
 * 纯 IO 封装，不碰存储：baseUrl / model / apiKey 全由调用方传入
 * （本地测试有默认值，正式发布由用户配置覆盖，所以这里没有任何 key 管理）。
 * fetch / sleep 注入 —— 单测用 mock 断言错误分级与重试，不发真请求。
 *
 * 兼容红线（iOS 12）：
 *   · 超时用 Promise.race，不碰 AbortController（Safari 12.1+ 才有）
 *   · 不用 replaceAll / globalThis / ?. 之外的运行时新 API（?. 由 esbuild 降级）
 */

export const DEFAULT_CFG = Object.freeze({
  // 浏览器走 serve.mjs 的同源反代（绕开本地代理无 CORS）；Node 侧直接连上游
  baseUrl: '/llm/v1',
  model: 'agnes-3.0-flash',
  apiKey: 'PROXY_MANAGED',
});

export const ERR = Object.freeze({
  NETWORK: 'NETWORK',   // fetch 失败：服务没开 / CORS 拦截
  TIMEOUT: 'TIMEOUT',   // 超时
  AUTH: 'AUTH',         // 401 / 403
  RATE: 'RATE',         // 429（可重试一次）
  UPSTREAM: 'UPSTREAM', // 5xx
  HTTP: 'HTTP',         // 其它非 2xx
  EMPTY: 'EMPTY',       // 无 content
  TRUNCATED: 'TRUNCATED', // finish_reason=length
});

export class LlmError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
  }
}

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function withTimeout(promise, ms, sleep) {
  let timer = null;
  const gate = new Promise((_, reject) => {
    // 浏览器 setTimeout / Node setTimeout 都返回可 clear 的句柄
    timer = setTimeout(() => reject(new LlmError(`LLM 请求超时（${ms}ms）`, ERR.TIMEOUT)), ms);
  });
  return Promise.race([promise, gate]).then(
    v => { if (timer) clearTimeout(timer); return v; },
    e => { if (timer) clearTimeout(timer); throw e; },
  );
}

function classifyHttp(status, bodyText) {
  const tail = bodyText ? `：${bodyText.slice(0, 200)}` : '';
  if (status === 401 || status === 403) return new LlmError(`key 或端点无效（HTTP ${status}）${tail}`, ERR.AUTH);
  if (status === 429) return new LlmError(`触发限流（HTTP 429）${tail}`, ERR.RATE);
  if (status >= 500) return new LlmError(`上游服务异常（HTTP ${status}）${tail}`, ERR.UPSTREAM);
  return new LlmError(`请求失败（HTTP ${status}）${tail}`, ERR.HTTP);
}

/**
 * 发一轮对话，返回 assistant 的 content 字符串。
 *
 * @param messages  [{role, content}, ...]
 * @param cfg       {baseUrl, model, apiKey}（缺省用 DEFAULT_CFG）
 * @param opts      {json, fetch, sleep, timeoutMs, retries}
 *                  json=true 时带 response_format json_object
 *                  retries 只对 RATE(429) 生效，默认补试 1 次
 */
export async function chat(messages, cfg = {}, opts = {}) {
  const c = { ...DEFAULT_CFG, ...cfg };
  const {
    json = false,
    fetch: doFetch = typeof fetch === 'function' ? fetch : null,
    sleep = defaultSleep,
    timeoutMs = 60000,
    retries = 1,
  } = opts;

  if (!doFetch) throw new LlmError('当前环境没有 fetch', ERR.NETWORK);
  if (!c.baseUrl) throw new LlmError('缺少 baseUrl 配置', ERR.AUTH);

  const url = `${c.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const body = { model: c.model, messages };
  if (json) body.response_format = { type: 'json_object' };

  let attempt = 0;
  for (;;) {
    try {
      return await once(url, body, c, { doFetch, sleep, timeoutMs });
    } catch (err) {
      if (err.code === ERR.RATE && attempt < retries) {
        attempt += 1;
        await sleep(3000); // 429 退避后补试一次
        continue;
      }
      throw err;
    }
  }
}

async function once(url, body, c, { doFetch, sleep, timeoutMs }) {
  let res;
  try {
    res = await withTimeout(doFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    }), timeoutMs, sleep);
  } catch (err) {
    if (err instanceof LlmError) throw err; // 超时原样抛
    throw new LlmError(
      `网络或 CORS 失败：${err && err.message ? err.message : err}。` +
      '（本地代理请走 serve.mjs 的 /llm 反代，或确认 LLM 服务已启动）',
      ERR.NETWORK,
    );
  }

  const text = await res.text();
  if (!res.ok) throw classifyHttp(res.status, text);

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new LlmError(`响应不是合法 JSON：${text.slice(0, 200)}`, ERR.UPSTREAM);
  }

  const choice = data && data.choices && data.choices[0];
  const msg = choice && choice.message;
  const content = msg && typeof msg.content === 'string' ? msg.content : '';
  if (!content) throw new LlmError('LLM 返回内容为空', ERR.EMPTY);
  if (choice.finish_reason === 'length') throw new LlmError('输出被截断（finish_reason=length）', ERR.TRUNCATED);
  return content;
}
