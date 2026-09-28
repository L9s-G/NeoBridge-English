/**
 * 数据库结构与读写接口。
 *
 * 五个对象仓库：
 *   meta     键值杂项 —— 当前激活的词包是谁
 *   pack     已下载的词包，**一个 packId 一个 key，多包共存**
 *   progress 每个词的进度，主键是 wordKey —— **删包、换包都永不清除**
 *   daily    按天的复习清单，主键 `日期|wordKey`，首页的 7 天卡片读它
 *   question 题库（S6 填充）
 *
 * 更新模型：不做自动更新。用户手动删除某个包 → 重新下载，即完成同步。
 */

import { del, getAll, getAllByIndex, getAllKeys, get, openDB, put, withTx } from './idb.js';

export const DB_NAME = 'niubridge';
/** v2：新增 daily 仓库（按天的复习清单） */
export const DB_VERSION = 2;

export const STORE = Object.freeze({
  META: 'meta',
  PACK: 'pack',
  PROGRESS: 'progress',
  QUESTION: 'question',
  DAILY: 'daily',
});

export const META_KEY = Object.freeze({ ACTIVE_PACK: 'active_pack' });

/** 词包唯一标识：同 packId 换版本算不同的包 */
export const packIdOf = manifest => `${manifest.packId}@${manifest.version}`;

function upgrade(db) {
  if (!db.objectStoreNames.contains(STORE.META)) {
    db.createObjectStore(STORE.META, { keyPath: 'key' });
  }
  if (!db.objectStoreNames.contains(STORE.PACK)) {
    db.createObjectStore(STORE.PACK, { keyPath: 'id' });
  }
  if (!db.objectStoreNames.contains(STORE.PROGRESS)) {
    const store = db.createObjectStore(STORE.PROGRESS, { keyPath: 'k' });
    // 两个索引给"最近复习 / 错词"查询用（S5），现在建好免得日后升版本
    store.createIndex('byLastAnswerAt', 'lastAnswerAt', { unique: false });
    store.createIndex('byLastResult', 'lastResult', { unique: false });
  }
  if (!db.objectStoreNames.contains(STORE.QUESTION)) {
    db.createObjectStore(STORE.QUESTION, { keyPath: 'id' });
  }
  if (!db.objectStoreNames.contains(STORE.DAILY)) {
    const store = db.createObjectStore(STORE.DAILY, { keyPath: 'id' });
    store.createIndex('byDay', 'day', { unique: false });
  }
}

export function openStore() {
  return openDB(DB_NAME, DB_VERSION, upgrade);
}

/* ---------------- 词包 ---------------- */

export function getPack(db, id) {
  return get(db, STORE.PACK, id);
}

export function listPacks(db) {
  return getAll(db, STORE.PACK);
}

/** 已下载的包 id 集合（启动自愈时逐个恢复用） */
export async function getDownloadedPackIds(db) {
  return new Set(await getAllKeys(db, STORE.PACK));
}

export function putPack(db, record) {
  return put(db, STORE.PACK, record);
}

/**
 * 删除本地记录（重新下载即为更新）。
 * **只删包本身，绝不碰 progress** —— 进度按 wordKey 存，跨包继承。
 */
export function deletePack(db, id) {
  return del(db, STORE.PACK, id);
}

export async function getActivePackId(db) {
  const rec = await get(db, STORE.META, META_KEY.ACTIVE_PACK);
  return rec ? rec.value : null;
}

export function setActivePackId(db, id) {
  return put(db, STORE.META, { key: META_KEY.ACTIVE_PACK, value: id });
}

/* ---------------- 进度 ---------------- */

/** 读出全部进度，得到 wordKey → state 的映射（调度器直接吃这个） */
export async function loadProgress(db) {
  const rows = await getAll(db, STORE.PROGRESS);
  const map = {};
  for (const row of rows) map[row.k] = row;
  return map;
}

/**
 * 写一条进度。记录必须带 k（store 的 keyPath），
 * 否则 IDB 会抛 DataError —— 这里提前给出可读的原因。
 */
export function saveProgress(db, state) {
  if (!state || !state.k) {
    return Promise.reject(new Error('进度记录缺少 wordKey，拒绝写入'));
  }
  return put(db, STORE.PROGRESS, state);
}

/**
 * 手动重置进度。**删包 / 换包流程绝不调用它** ——
 * 日后发 C2 包时，B1/B2 的进度按 wordKey 自动继承。
 */
export function clearProgress(db) {
  return withTx(db, [STORE.PROGRESS], 'readwrite', stores => {
    stores[STORE.PROGRESS].clear();
  });
}

/* ---------------- 按天的复习清单 ---------------- */

export const dailyId = (day, k) => `${day}|${k}`;

/**
 * 记一笔"当天复习过 k"。同一天同一个词只留一条：
 * `at` 取当天最后一次作答时间，`wrong` 取当天是否至少错过一次（只进不出）。
 */
export async function saveDaily(db, { day, k, at, wrong }) {
  const id = dailyId(day, k);
  const prev = await get(db, STORE.DAILY, id);
  await put(db, STORE.DAILY, {
    id,
    day,
    k,
    at,
    wrong: wrong || !!prev?.wrong,
  });
}

/** 一段日期内的复习记录（含端点），按 day 索引范围取 */
export function loadDaily(db, from, to) {
  return getAllByIndex(db, STORE.DAILY, 'byDay', IDBKeyRange.bound(from, to));
}
