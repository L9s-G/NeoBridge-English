/**
 * IndexedDB 的极简 Promise 封装，不引第三方库。
 *
 * 只保证两件事：
 *   1. 单个请求可以 await；
 *   2. 多个写入要原子提交时，把请求全部放进 withTx 的**同步**回调里 ——
 *      IDB 事务会在回调返回、且没有新请求排队时自动提交，
 *      所以回调里不能 await（一旦让出事件循环事务就失效了）。
 */

/** IDBRequest → Promise */
export function req(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** IDBTransaction 的提交/中止 → Promise */
function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB 事务失败'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB 事务被中止'));
  });
}

export function openDB(name, version, upgrade) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.onupgradeneeded = () => upgrade(request.result, request.transaction);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error(`${name} 被其他标签页占用，请关掉旧页面`));
  });
}

/**
 * 在同一个事务里执行 fn。fn 必须同步发起全部请求，
 * 返回后等待事务提交；任一请求失败则整体回滚。
 */
export async function withTx(db, storeNames, mode, fn) {
  const tx = db.transaction(storeNames, mode);
  const stores = {};
  for (const name of storeNames) stores[name] = tx.objectStore(name);

  const done = txDone(tx);
  fn(stores);
  await done;
}

export function get(db, storeName, key) {
  return req(db.transaction(storeName, 'readonly').objectStore(storeName).get(key));
}

export function getAll(db, storeName) {
  return req(db.transaction(storeName, 'readonly').objectStore(storeName).getAll());
}

/** 按索引取一段；range 传 null 即取全部 */
export function getAllByIndex(db, storeName, indexName, range = null) {
  const store = db.transaction(storeName, 'readonly').objectStore(storeName);
  return req(store.index(indexName).getAll(range));
}

export function getAllKeys(db, storeName) {
  return req(db.transaction(storeName, 'readonly').objectStore(storeName).getAllKeys());
}

export function put(db, storeName, value) {
  return req(db.transaction(storeName, 'readwrite').objectStore(storeName).put(value));
}

export function del(db, storeName, key) {
  return req(db.transaction(storeName, 'readwrite').objectStore(storeName).delete(key));
}
