/**
 * 词包的下载、落库、启动自愈与删除。
 *
 * 设计跟 Black2Lock-reborn 的 DLC 层对齐：
 *   · 一个 packId 一个 key，**多包共存**，各自可下载 / 删除 / 切换
 *   · 下载：fetch → 校验 → 持久化到 IndexedDB
 *   · 启动：遍历已下载的包逐个解码校验，**坏的自动删掉**（自愈）
 *   · 更新：**不做自动更新**，用户手动删除 → 重新下载即同步
 *   · 进度存在 progress 仓库，主键 wordKey，任何一步都不碰它
 *
 * 我们比参考项目多拿一层 manifest.sha256：下载时校验，启动时靠
 * 结构自洽（计数、schema、wordKey）兜底 —— 字节损坏几乎必然先在这里炸。
 */

import { deletePack, getActivePackId, getDownloadedPackIds, getPack, packIdOf, putPack, setActivePackId } from './stores.js';

/** 词包结构版本，跟 pack 头里的 schemaVersion 对齐 */
export const SCHEMA_VERSION = 1;

export async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 纯函数：包内自洽性校验。不需要 manifest，启动自愈时也能用。
 * 任何一项不符都抛错，抛在落库 / 使用之前。
 */
export function validatePack(payload) {
  const fail = msg => { throw new Error(`词包损坏：${msg}`); };

  if (payload.schemaVersion !== SCHEMA_VERSION) fail(`schemaVersion ${payload.schemaVersion} ≠ ${SCHEMA_VERSION}`);
  if (typeof payload.baseUrl !== 'string' || !payload.baseUrl) fail('缺少 baseUrl');
  if (!Array.isArray(payload.words)) fail('缺少 words 数组');

  if (payload.words.length !== payload.wordCount) {
    fail(`words 数组 ${payload.words.length} ≠ wordCount ${payload.wordCount}`);
  }
  const senses = payload.words.reduce((n, w) => n + (w.senses ? w.senses.length : 0), 0);
  if (senses !== payload.senseCount) fail(`义项实际 ${senses} ≠ senseCount ${payload.senseCount}`);

  const noKey = payload.words.filter(w => !w.k).length;
  if (noKey) fail(`${noKey} 个词缺少 wordKey`);

  return true;
}

/** 下载路径专用：字节数 + sha256 + 与 manifest 的交叉核对 + 包内自洽 */
export async function buildPackRecord(bytes, manifest, importedAt) {
  const fail = msg => { throw new Error(`词包校验失败：${msg}`); };

  if (bytes.byteLength !== manifest.bytes) fail(`字节数 ${bytes.byteLength} ≠ manifest ${manifest.bytes}`);

  const sha256 = await sha256Hex(bytes);
  if (sha256 !== manifest.sha256) fail(`sha256 ${sha256} ≠ manifest ${manifest.sha256}`);

  const payload = JSON.parse(new TextDecoder('utf-8').decode(bytes));
  validatePack(payload);

  if (payload.packId !== manifest.packId) fail(`packId ${payload.packId} ≠ manifest ${manifest.packId}`);
  if (payload.version !== manifest.version) fail(`version ${payload.version} ≠ manifest ${manifest.version}`);
  if (payload.wordCount !== manifest.wordCount) fail(`wordCount ${payload.wordCount} ≠ manifest ${manifest.wordCount}`);
  if (payload.senseCount !== manifest.senseCount) fail(`senseCount ${payload.senseCount} ≠ manifest ${manifest.senseCount}`);

  return {
    id: packIdOf(manifest),
    packId: manifest.packId,
    version: manifest.version,
    schemaVersion: payload.schemaVersion,
    levels: payload.levels,
    baseUrl: payload.baseUrl,
    wordCount: payload.wordCount,
    senseCount: payload.senseCount,
    bytes: bytes.byteLength,
    sha256,
    importedAt,
    data: bytes,   // 存原始字节，读时再解码，避免存两份
  };
}

/** 解出词包正文；损坏的字节在这里抛 JSON 解析错 */
export function decodePack(record) {
  return JSON.parse(new TextDecoder('utf-8').decode(record.data));
}

/* ---------------- 下载 ---------------- */

async function fetchOk(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`拉取失败 ${url}：HTTP ${res.status}`);
  return res;
}

/**
 * 下载一个词包并持久化。返回落库记录。
 * `activate` 为 true 时顺带设为当前学习的包。
 */
export async function downloadPack(db, { baseUrl = './data/', activate = true, now = () => Date.now() } = {}) {
  const manifest = await (await fetchOk(baseUrl + 'manifest.json')).json();
  const bytes = await (await fetchOk(baseUrl + manifest.file)).arrayBuffer();
  const record = await buildPackRecord(bytes, manifest, now());

  await removeSuperseded(db, record);
  await putPack(db, record);
  if (activate) await setActivePackId(db, record.id);
  return record;
}

/** 同 packId 的旧版本在显式重下后让位，避免列表里出现两条 B1B2 */
async function removeSuperseded(db, record) {
  const ids = await getDownloadedPackIds(db);
  for (const id of ids) {
    if (id !== record.id && id.split('@')[0] === record.packId) await deletePack(db, id);
  }
}

/* ---------------- 启动自愈 ---------------- */

/**
 * 读回所有已下载的包，逐个解码 + 结构校验；
 * 坏的直接删掉（只删包，不动进度），返回可用包与被清理的 id。
 */
export async function restorePacks(db) {
  const packs = [];
  const removed = [];

  for (const id of await getDownloadedPackIds(db)) {
    const record = await getPack(db, id);
    if (!record) continue;
    try {
      packs.push({ record, payload: validateAndDecode(record) });
    } catch (err) {
      console.warn(`词包 ${id} 损坏，已清理：`, err.message);
      await deletePack(db, id);
      removed.push(id);
    }
  }

  // 激活指针指向了已消失的包 → 收拾一下
  const active = await getActivePackId(db);
  if (!active || !packs.some(p => p.record.id === active)) {
    await setActivePackId(db, packs.length ? packs[0].record.id : null);
  }

  return { packs, removed };
}

function validateAndDecode(record) {
  if (!record.data || record.data.byteLength !== record.bytes) {
    throw new Error(`字节数 ${record.data ? record.data.byteLength : 0} ≠ 记录 ${record.bytes}`);
  }
  const payload = decodePack(record);
  validatePack(payload);
  return payload;
}

/* ---------------- 删除与切换 ---------------- */

/**
 * 删除本地记录 —— 用户实现"更新同步"的入口：删掉 → 重新下载。
 * 进度按 wordKey 存，**不会**跟着包一起消失。
 */
export async function removePack(db, id) {
  await deletePack(db, id);
  if (await getActivePackId(db) === id) {
    const rest = [...await getDownloadedPackIds(db)];
    await setActivePackId(db, rest.length ? rest[0] : null);
  }
}

export { setActivePackId };
