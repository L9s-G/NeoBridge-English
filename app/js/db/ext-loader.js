/**
 * 扩展数据加载器：app/data/ext.v1.json → Map(wordKey → 扩展条目)。
 *
 * 更新模型（与词包、外壳缓存都无关，push 即在线更新）：
 *   1. manifest-ext.json 走网络优先（SW isDataUrl）—— 在线永远拿到最新 sha；
 *      拿不到（离线/换壳后 shell 缓存被清）就退回本地正文旁存的 meta
 *   2. 目标 sha = 新 manifest.sha256；与本地一致且正文在 → 零流量直接用
 *   3. sha 变了 / 本地没有 → 拉正文 → 按目标 sha 校验 → 存进独立缓存
 *      neobridge-ext（换 SHELL_CACHE 版本号不会连坐清掉这 4 MB）
 *   4. 拉正文失败但本地有旧数据 → 用旧的（stale）；彻底没有 → null
 *
 * null = 扩展数据不可用：卡背扩展区、字典的扩展内容整块不渲染，不报错、不打扰。
 * 词包（IndexedDB，手动更新）与它完全独立 —— 扩展数据只读、随发布静默更新。
 * 没有 Cache Storage 的环境（http 局域网非安全上下文）：不落缓存，
 * 每次启动按 manifest 拉一次正文（开发场景可接受）。
 *
 * 纯函数 decideExt 给出行动表，单测盯着；本文件其余部分只做 IO，全部失败兜底到 null。
 */

import { sha256Hex } from './importer.js';

export const EXT_CACHE = 'neobridge-ext';
const BODY_URL = './data/ext.v1.json';
const MANIFEST_URL = './data/manifest-ext.json';

/**
 * 行动表（纯函数，单测覆盖）：
 *   use-cache  新 sha == 本地 sha 且正文在 → 不联网
 *   fetch      本地没正文 → 拉正文（校验 plan.sha）
 *   refresh    本地有正文但 sha 落后 → 拉新（失败退回旧数据）
 *   unavailable 两头都没有 sha → 没有可用数据
 */
export function decideExt({ manifestSha, storedSha, hasBody }) {
  const desired = manifestSha || storedSha;
  if (!desired) return { action: 'unavailable', sha: null };
  if (desired === storedSha && hasBody) return { action: 'use-cache', sha: desired };
  if (hasBody) return { action: 'refresh', sha: desired };
  return { action: 'fetch', sha: desired };
}

function parseExt(text, meta) {
  const payload = JSON.parse(text);
  if (!payload || typeof payload.words !== 'object'
    || Object.keys(payload.words).length !== payload.count) {
    throw new Error('扩展数据结构不自洽');
  }
  return {
    map: new Map(Object.entries(payload.words)),
    extVersion: payload.extVersion,
    count: payload.count,
    sha256: meta.sha,
    fromCache: !!meta.fromCache,
  };
}

/**
 * @returns {Promise<{map, extVersion, count, sha256, fromCache}|null>}
 *          null = 扩展数据不可用（无网、无缓存、校验不过），调用方优雅降级。
 */
export async function loadExt({ fetchImpl, cachesOk } = {}) {
  try {
    const f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
    if (!f) return null;
    const hasCaches = cachesOk !== undefined ? cachesOk : typeof caches !== 'undefined';

    // 1) manifest：在线拿最新 sha（SW 网络优先），失败靠本地 meta 兜底
    let manifestSha = null;
    let manifest = null;
    try {
      const res = await f(MANIFEST_URL);
      if (res.ok) {
        manifest = await res.json();
        if (typeof manifest.sha256 === 'string') manifestSha = manifest.sha256;
      }
    } catch { /* 离线：下面用本地 meta */ }

    // 2) 本地状态：meta（存的 manifest 副本）+ 正文
    let storedSha = null;
    let bodyText = null;
    if (hasCaches) {
      try {
        const cache = await caches.open(EXT_CACHE);
        const metaRes = await cache.match(MANIFEST_URL);
        if (metaRes) {
          const stored = await metaRes.json();
          if (typeof stored.sha256 === 'string') storedSha = stored.sha256;
        }
        const bodyRes = await cache.match(BODY_URL);
        if (bodyRes) bodyText = await bodyRes.text();
      } catch { /* 缓存读不了当没有，走联网 */ }
    }

    const plan = decideExt({ manifestSha, storedSha, hasBody: bodyText != null });
    if (plan.action === 'unavailable') return null;
    if (plan.action === 'use-cache') return parseExt(bodyText, { sha: plan.sha, fromCache: true });

    // 3) 需要正文：按目标 sha 校验，过了才存
    try {
      const res = await f(BODY_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buffer = await res.arrayBuffer();
      const sha = await sha256Hex(buffer);
      if (sha !== plan.sha) throw new Error(`sha256 不符（正文 ${sha.slice(0, 12)} ≠ 目标 ${plan.sha.slice(0, 12)}）`);
      const text = new TextDecoder('utf-8').decode(buffer);

      if (hasCaches) {
        try {
          const cache = await caches.open(EXT_CACHE);
          await cache.put(BODY_URL, new Response(text, { headers: { 'Content-Type': 'application/json' } }));
          if (manifest) {
            await cache.put(MANIFEST_URL, new Response(JSON.stringify(manifest), { headers: { 'Content-Type': 'application/json' } }));
          }
        } catch (err) {
          console.warn('扩展数据写缓存失败（本次仍可用）：', err);
        }
      }
      return parseExt(text, { sha: plan.sha, fromCache: false });
    } catch (err) {
      if (bodyText != null) {
        console.warn('拉取扩展数据失败，退回本地旧版：', err);
        return parseExt(bodyText, { sha: storedSha, fromCache: true });
      }
      console.warn('扩展数据不可用：', err);
      return null;
    }
  } catch (err) {
    console.warn('扩展数据加载异常（不影响词包）：', err);
    return null;
  }
}
