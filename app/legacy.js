(() => {
  // app/js/core/day.js
  var WEEK = ["\u5468\u65E5", "\u5468\u4E00", "\u5468\u4E8C", "\u5468\u4E09", "\u5468\u56DB", "\u5468\u4E94", "\u5468\u516D"];
  var pad = (n) => String(n).padStart(2, "0");
  function dayKey(ms) {
    const d = new Date(ms);
    return "".concat(d.getFullYear(), "-").concat(pad(d.getMonth() + 1), "-").concat(pad(d.getDate()));
  }
  function lastDays(n, now = Date.now()) {
    const base = new Date(now);
    const out = [];
    for (let i = n - 1; i >= 0; i--) {
      out.push(dayKey(new Date(base.getFullYear(), base.getMonth(), base.getDate() - i)));
    }
    return out;
  }
  function dayLabel(key) {
    const [y, m, d] = key.split("-").map(Number);
    const date = new Date(y, m - 1, d);
    return "".concat(m, "\u6708").concat(d, "\u65E5 ").concat(WEEK[date.getDay()]);
  }
  function relDay(ms, now = Date.now()) {
    if (ms == null) return "";
    const diff = Math.round((Date.parse(dayKey(now)) - Date.parse(dayKey(ms))) / 864e5);
    if (diff <= 0) return "\u4ECA\u5929";
    if (diff === 1) return "\u6628\u5929";
    return "".concat(diff, " \u5929\u524D");
  }

  // app/js/core/dict.js
  function normalize(text) {
    return String(text == null ? "" : text).trim().toLowerCase().replace(/\s+/g, " ");
  }
  function searchWords(words, query) {
    const q = normalize(query);
    if (!q) return [];
    const hits = [];
    for (const w of words || []) {
      const form = normalize(w.w);
      if (!form) continue;
      let rank = -1;
      if (form === q) rank = 0;
      else if (form.indexOf(q) === 0) rank = 1;
      else if (form.indexOf(q) > 0) rank = 2;
      if (rank >= 0) hits.push({ w, form, rank });
    }
    hits.sort((a, b) => a.rank - b.rank || a.form.length - b.form.length || (a.form < b.form ? -1 : a.form > b.form ? 1 : 0));
    return hits.map((x) => x.w);
  }

  // app/js/core/params.js
  var DEFAULT_PARAMS = {
    /** 等级权重：B2 出现得更频繁 */
    levelWeight: { B2: 1.4, B1: 1 },
    /** 掌握度抑制指数，越大则"已掌握"的词被抽中的概率降得越快 */
    masteryExponent: 1.6,
    /** 池内新鲜度衰减系数：见得越多越不优先，防止同池里老词霸屏 */
    freshnessDecay: 0.1,
    /** mastery 低于此值即划入错词池 */
    errPoolThreshold: 0.45,
    /**
     * 错过的词要连续答对几次才算"恢复"。
     * 只影响两处：错词名单的收录、错词池的划分 —— **不进权重公式**。
     */
    recoverStreak: 2,
    /**
     * 三池配额随 coverage（新词完成度）从 start 线性走到 end。
     * 新词还没过完时错词只占 10%，过完后抬到 40% —— 这正是
     * "错误与新词的比例"的实现方式，错误加成不进权重公式。
     */
    quotas: {
      start: { new: 0.75, err: 0.1, rev: 0.15 },
      end: { new: 0.3, err: 0.4, rev: 0.3 }
    },
    /**
     * 作答信号 → mastery 变化。
     * mul 表示乘上去（负向），add 表示向 1 逼近的增量（正向）。
     */
    masteryDelta: {
      wrong: { mul: 0.45 },
      fuzzy: { mul: 0.75 },
      right: { add: 0.18 },
      examRight: { add: 0.3 }
    }
  };
  function withParams(overrides = {}) {
    const p = overrides.quotas || {};
    return {
      ...DEFAULT_PARAMS,
      ...overrides,
      levelWeight: { ...DEFAULT_PARAMS.levelWeight, ...overrides.levelWeight || {} },
      quotas: {
        start: { ...DEFAULT_PARAMS.quotas.start, ...p.start || {} },
        end: { ...DEFAULT_PARAMS.quotas.end, ...p.end || {} }
      },
      masteryDelta: { ...DEFAULT_PARAMS.masteryDelta, ...overrides.masteryDelta || {} }
    };
  }

  // app/js/core/progress.js
  function createState(now = null, k = null) {
    return {
      k,
      mastery: 0,
      // 掌握度 [0,1]，抽样与划池的核心
      lastResult: null,
      // 'right' | 'fuzzy' | 'wrong' | 'examRight' | null
      timesSeen: 0,
      // 被抽中的次数，池内新鲜度用
      answers: 0,
      rights: 0,
      wrongs: 0,
      // 累计答错次数，>0 即进过错词名单
      wrongStreak: 0,
      // 连续答错，用于"连续答错"提示
      rightStreak: 0,
      // 连续答对，错词恢复条件用
      firstSeenAt: now,
      lastSeenAt: now,
      lastAnswerAt: null,
      lastWrongAt: null
      // 最后一次答错的时间，错词名单按它排序
    };
  }
  function markSeen(state, now = null) {
    const next = state ? { ...state } : createState(now);
    next.timesSeen = (next.timesSeen || 0) + 1;
    next.lastSeenAt = now;
    if (next.firstSeenAt == null) next.firstSeenAt = now;
    return next;
  }
  function coverageOf(states, words) {
    if (!words || !words.length) return 0;
    let answered = 0;
    for (const w of words) {
      const s = states[w.k];
      if (s && s.lastResult != null) answered++;
    }
    return answered / words.length;
  }

  // app/js/core/mastery.js
  var SIGNAL = Object.freeze({
    RIGHT: "right",
    // 按钮"熟悉"
    FUZZY: "fuzzy",
    // 按钮"一般"
    WRONG: "wrong",
    // 按钮"标记" / 题型答错
    EXAM_RIGHT: "examRight"
    // 考试题型答对（主动回忆，增益高于自评）
  });
  var clamp01 = (n) => n < 0 ? 0 : n > 1 ? 1 : n;
  function applyAnswer(state, signal, now = null, params2) {
    var _a;
    const rule = params2.masteryDelta[signal];
    if (!rule) throw new Error("unknown signal: ".concat(signal));
    const prev = state || {};
    const mastery = (_a = prev.mastery) != null ? _a : 0;
    const next = { ...prev };
    next.mastery = rule.mul !== void 0 ? clamp01(mastery * rule.mul) : clamp01(mastery + (1 - mastery) * rule.add);
    next.lastResult = signal;
    next.answers = (prev.answers || 0) + 1;
    next.lastAnswerAt = now;
    if (signal === SIGNAL.RIGHT || signal === SIGNAL.EXAM_RIGHT) {
      next.rights = (prev.rights || 0) + 1;
      next.wrongStreak = 0;
      next.rightStreak = (prev.rightStreak || 0) + 1;
    } else if (signal === SIGNAL.WRONG) {
      next.wrongStreak = (prev.wrongStreak || 0) + 1;
      next.wrongs = (prev.wrongs || 0) + 1;
      next.rightStreak = 0;
      next.lastWrongAt = now;
    } else {
      next.rightStreak = 0;
    }
    if (next.firstSeenAt == null) next.firstSeenAt = now;
    return next;
  }

  // app/js/core/pools.js
  var POOL = Object.freeze({ NEW: "new", ERR: "err", REV: "rev" });
  var POOLS = [POOL.NEW, POOL.ERR, POOL.REV];
  function poolOf(state, params2) {
    var _a;
    if (!state || state.lastResult == null) return POOL.NEW;
    if (state.lastResult === SIGNAL.WRONG) return POOL.ERR;
    if (isWrongWord(state, params2)) return POOL.ERR;
    if (((_a = state.mastery) != null ? _a : 0) < params2.errPoolThreshold) return POOL.ERR;
    return POOL.REV;
  }
  function isWrongWord(state, params2) {
    if (!state || (state.wrongs || 0) <= 0) return false;
    return (state.rightStreak || 0) < params2.recoverStreak;
  }
  var lerp = (a, b, t) => a + (b - a) * t;
  function quotasFor(coverage, params2) {
    const t = coverage <= 0 ? 0 : coverage >= 1 ? 1 : coverage;
    const { start, end } = params2.quotas;
    return {
      new: lerp(start.new, end.new, t),
      err: lerp(start.err, end.err, t),
      rev: lerp(start.rev, end.rev, t)
    };
  }
  function normalizeQuotas(quotas, available) {
    const out = { new: 0, err: 0, rev: 0 };
    if (!available.length) return out;
    let total = 0;
    for (const p of available) total += quotas[p] || 0;
    if (total <= 0) {
      const even = 1 / available.length;
      for (const p of available) out[p] = even;
      return out;
    }
    for (const p of available) out[p] = (quotas[p] || 0) / total;
    return out;
  }

  // app/js/core/sha256.js
  var K = new Uint32Array([
    1116352408,
    1899447441,
    3049323471,
    3921009573,
    961987163,
    1508970993,
    2453635748,
    2870763221,
    3624381080,
    310598401,
    607225278,
    1426881987,
    1925078388,
    2162078206,
    2614888103,
    3248222580,
    3835390401,
    4022224774,
    264347078,
    604807628,
    770255983,
    1249150122,
    1555081692,
    1996064986,
    2554220882,
    2821834349,
    2952996808,
    3210313671,
    3336571891,
    3584528711,
    113926993,
    338241895,
    666307205,
    773529912,
    1294757372,
    1396182291,
    1695183700,
    1986661051,
    2177026350,
    2456956037,
    2730485921,
    2820302411,
    3259730800,
    3345764771,
    3516065817,
    3600352804,
    4094571909,
    275423344,
    430227734,
    506948616,
    659060556,
    883997877,
    958139571,
    1322822218,
    1537002063,
    1747873779,
    1955562222,
    2024104815,
    2227730452,
    2361852424,
    2428436474,
    2756734187,
    3204031479,
    3329325298
  ]);
  var H0 = new Uint32Array([
    1779033703,
    3144134277,
    1013904242,
    2773480762,
    1359893119,
    2600822924,
    528734635,
    1541459225
  ]);
  var rotr = (x, n) => (x >>> n | x << 32 - n) >>> 0;
  function sha256Bytes(input) {
    const len = input.length;
    const padded = new Uint8Array(Math.floor((len + 9 + 63) / 64) * 64);
    padded.set(input);
    padded[len] = 128;
    const view2 = new DataView(padded.buffer);
    view2.setUint32(padded.length - 8, Math.floor(len / 536870912), false);
    view2.setUint32(padded.length - 4, len << 3 >>> 0, false);
    const h2 = new Uint32Array(H0);
    const w = new Uint32Array(64);
    for (let off = 0; off < padded.length; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = view2.getUint32(off + i * 4, false);
      for (let i = 16; i < 64; i++) {
        const x = w[i - 15];
        const y = w[i - 2];
        const s0 = (rotr(x, 7) ^ rotr(x, 18) ^ x >>> 3) >>> 0;
        const s1 = (rotr(y, 17) ^ rotr(y, 19) ^ y >>> 10) >>> 0;
        w[i] = w[i - 16] + s0 + w[i - 7] + s1 >>> 0;
      }
      let a = h2[0], b = h2[1], c = h2[2], d = h2[3];
      let e = h2[4], f = h2[5], g = h2[6], hh = h2[7];
      for (let i = 0; i < 64; i++) {
        const s1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
        const ch = (e & f ^ ~e & g) >>> 0;
        const t1 = hh + s1 + ch + K[i] + w[i] >>> 0;
        const s0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
        const maj = (a & b ^ a & c ^ b & c) >>> 0;
        const t2 = s0 + maj >>> 0;
        hh = g;
        g = f;
        f = e;
        e = d + t1 >>> 0;
        d = c;
        c = b;
        b = a;
        a = t1 + t2 >>> 0;
      }
      h2[0] = h2[0] + a >>> 0;
      h2[1] = h2[1] + b >>> 0;
      h2[2] = h2[2] + c >>> 0;
      h2[3] = h2[3] + d >>> 0;
      h2[4] = h2[4] + e >>> 0;
      h2[5] = h2[5] + f >>> 0;
      h2[6] = h2[6] + g >>> 0;
      h2[7] = h2[7] + hh >>> 0;
    }
    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h2[i], false);
    return out;
  }

  // app/js/db/idb.js
  function req(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  function openDB(name, version, upgrade2) {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(name, version);
      request.onupgradeneeded = () => upgrade2(request.result, request.transaction);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("".concat(name, " \u88AB\u5176\u4ED6\u6807\u7B7E\u9875\u5360\u7528\uFF0C\u8BF7\u5173\u6389\u65E7\u9875\u9762")));
    });
  }
  function get(db2, storeName, key) {
    return req(db2.transaction(storeName, "readonly").objectStore(storeName).get(key));
  }
  function getAll(db2, storeName) {
    return req(db2.transaction(storeName, "readonly").objectStore(storeName).getAll());
  }
  function getAllByIndex(db2, storeName, indexName, range = null) {
    const store = db2.transaction(storeName, "readonly").objectStore(storeName);
    return req(store.index(indexName).getAll(range));
  }
  function getAllKeys(db2, storeName) {
    return req(db2.transaction(storeName, "readonly").objectStore(storeName).getAllKeys());
  }
  function put(db2, storeName, value) {
    return req(db2.transaction(storeName, "readwrite").objectStore(storeName).put(value));
  }
  function del(db2, storeName, key) {
    return req(db2.transaction(storeName, "readwrite").objectStore(storeName).delete(key));
  }

  // app/js/db/stores.js
  var DB_NAME = "neobridge";
  var DB_VERSION = 2;
  var STORE = Object.freeze({
    META: "meta",
    PACK: "pack",
    PROGRESS: "progress",
    QUESTION: "question",
    DAILY: "daily"
  });
  var META_KEY = Object.freeze({ ACTIVE_PACK: "active_pack" });
  var packIdOf = (manifest) => "".concat(manifest.packId, "@").concat(manifest.version);
  function upgrade(db2) {
    if (!db2.objectStoreNames.contains(STORE.META)) {
      db2.createObjectStore(STORE.META, { keyPath: "key" });
    }
    if (!db2.objectStoreNames.contains(STORE.PACK)) {
      db2.createObjectStore(STORE.PACK, { keyPath: "id" });
    }
    if (!db2.objectStoreNames.contains(STORE.PROGRESS)) {
      const store = db2.createObjectStore(STORE.PROGRESS, { keyPath: "k" });
      store.createIndex("byLastAnswerAt", "lastAnswerAt", { unique: false });
      store.createIndex("byLastResult", "lastResult", { unique: false });
    }
    if (!db2.objectStoreNames.contains(STORE.QUESTION)) {
      db2.createObjectStore(STORE.QUESTION, { keyPath: "id" });
    }
    if (!db2.objectStoreNames.contains(STORE.DAILY)) {
      const store = db2.createObjectStore(STORE.DAILY, { keyPath: "id" });
      store.createIndex("byDay", "day", { unique: false });
    }
  }
  function openStore() {
    return openDB(DB_NAME, DB_VERSION, upgrade);
  }
  function getPack(db2, id) {
    return get(db2, STORE.PACK, id);
  }
  async function getDownloadedPackIds(db2) {
    return new Set(await getAllKeys(db2, STORE.PACK));
  }
  function putPack(db2, record) {
    return put(db2, STORE.PACK, record);
  }
  function deletePack(db2, id) {
    return del(db2, STORE.PACK, id);
  }
  async function getActivePackId(db2) {
    const rec = await get(db2, STORE.META, META_KEY.ACTIVE_PACK);
    return rec ? rec.value : null;
  }
  function setActivePackId(db2, id) {
    return put(db2, STORE.META, { key: META_KEY.ACTIVE_PACK, value: id });
  }
  async function loadProgress(db2) {
    const rows = await getAll(db2, STORE.PROGRESS);
    const map = {};
    for (const row of rows) map[row.k] = row;
    return map;
  }
  function saveProgress(db2, state) {
    if (!state || !state.k) {
      return Promise.reject(new Error("\u8FDB\u5EA6\u8BB0\u5F55\u7F3A\u5C11 wordKey\uFF0C\u62D2\u7EDD\u5199\u5165"));
    }
    return put(db2, STORE.PROGRESS, state);
  }
  var dailyId = (day, k) => "".concat(day, "|").concat(k);
  async function saveDaily(db2, { day, k, at, wrong }) {
    const id = dailyId(day, k);
    const prev = await get(db2, STORE.DAILY, id);
    await put(db2, STORE.DAILY, {
      id,
      day,
      k,
      at,
      wrong: wrong || !!(prev == null ? void 0 : prev.wrong)
    });
  }
  function loadDaily(db2, from, to) {
    return getAllByIndex(db2, STORE.DAILY, "byDay", IDBKeyRange.bound(from, to));
  }

  // app/js/db/importer.js
  var SCHEMA_VERSION = 1;
  var toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  async function sha256Hex(buffer) {
    try {
      if (typeof crypto !== "undefined" && crypto.subtle) {
        const digest = await crypto.subtle.digest("SHA-256", buffer);
        return toHex(new Uint8Array(digest));
      }
    } catch (err) {
      console.warn("crypto.subtle \u4E0D\u53EF\u7528\uFF0C\u56DE\u843D\u7EAF JS SHA-256\uFF1A", err);
    }
    return toHex(sha256Bytes(new Uint8Array(buffer)));
  }
  function validatePack(payload) {
    const fail = (msg) => {
      throw new Error("\u8BCD\u5305\u635F\u574F\uFF1A".concat(msg));
    };
    if (payload.schemaVersion !== SCHEMA_VERSION) fail("schemaVersion ".concat(payload.schemaVersion, " \u2260 ").concat(SCHEMA_VERSION));
    if (typeof payload.baseUrl !== "string" || !payload.baseUrl) fail("\u7F3A\u5C11 baseUrl");
    if (!Array.isArray(payload.words)) fail("\u7F3A\u5C11 words \u6570\u7EC4");
    if (payload.words.length !== payload.wordCount) {
      fail("words \u6570\u7EC4 ".concat(payload.words.length, " \u2260 wordCount ").concat(payload.wordCount));
    }
    const senses = payload.words.reduce((n, w) => n + (w.senses ? w.senses.length : 0), 0);
    if (senses !== payload.senseCount) fail("\u4E49\u9879\u5B9E\u9645 ".concat(senses, " \u2260 senseCount ").concat(payload.senseCount));
    const noKey = payload.words.filter((w) => !w.k).length;
    if (noKey) fail("".concat(noKey, " \u4E2A\u8BCD\u7F3A\u5C11 wordKey"));
    return true;
  }
  async function buildPackRecord(bytes, manifest, importedAt) {
    const fail = (msg) => {
      throw new Error("\u8BCD\u5305\u6821\u9A8C\u5931\u8D25\uFF1A".concat(msg));
    };
    if (bytes.byteLength !== manifest.bytes) fail("\u5B57\u8282\u6570 ".concat(bytes.byteLength, " \u2260 manifest ").concat(manifest.bytes));
    const sha256 = await sha256Hex(bytes);
    if (sha256 !== manifest.sha256) fail("sha256 ".concat(sha256, " \u2260 manifest ").concat(manifest.sha256));
    const payload = JSON.parse(new TextDecoder("utf-8").decode(bytes));
    validatePack(payload);
    if (payload.packId !== manifest.packId) fail("packId ".concat(payload.packId, " \u2260 manifest ").concat(manifest.packId));
    if (payload.version !== manifest.version) fail("version ".concat(payload.version, " \u2260 manifest ").concat(manifest.version));
    if (payload.wordCount !== manifest.wordCount) fail("wordCount ".concat(payload.wordCount, " \u2260 manifest ").concat(manifest.wordCount));
    if (payload.senseCount !== manifest.senseCount) fail("senseCount ".concat(payload.senseCount, " \u2260 manifest ").concat(manifest.senseCount));
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
      data: bytes
      // 存原始字节，读时再解码，避免存两份
    };
  }
  function decodePack(record) {
    return JSON.parse(new TextDecoder("utf-8").decode(record.data));
  }
  async function fetchOk(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error("\u62C9\u53D6\u5931\u8D25 ".concat(url, "\uFF1AHTTP ").concat(res.status));
    return res;
  }
  async function downloadPack(db2, { baseUrl = "./data/", activate = true, now = () => Date.now() } = {}) {
    const manifest = await (await fetchOk(baseUrl + "manifest.json")).json();
    const bytes = await (await fetchOk(baseUrl + manifest.file)).arrayBuffer();
    const record = await buildPackRecord(bytes, manifest, now());
    await removeSuperseded(db2, record);
    await putPack(db2, record);
    if (activate) await setActivePackId(db2, record.id);
    return record;
  }
  async function removeSuperseded(db2, record) {
    const ids = await getDownloadedPackIds(db2);
    for (const id of ids) {
      if (id !== record.id && id.split("@")[0] === record.packId) await deletePack(db2, id);
    }
  }
  async function restorePacks(db2) {
    const packs = [];
    const removed = [];
    for (const id of await getDownloadedPackIds(db2)) {
      const record = await getPack(db2, id);
      if (!record) continue;
      try {
        packs.push({ record, payload: validateAndDecode(record) });
      } catch (err) {
        console.warn("\u8BCD\u5305 ".concat(id, " \u635F\u574F\uFF0C\u5DF2\u6E05\u7406\uFF1A"), err.message);
        await deletePack(db2, id);
        removed.push(id);
      }
    }
    const active = await getActivePackId(db2);
    if (!active || !packs.some((p) => p.record.id === active)) {
      await setActivePackId(db2, packs.length ? packs[0].record.id : null);
    }
    return { packs, removed };
  }
  function validateAndDecode(record) {
    if (!record.data || record.data.byteLength !== record.bytes) {
      throw new Error("\u5B57\u8282\u6570 ".concat(record.data ? record.data.byteLength : 0, " \u2260 \u8BB0\u5F55 ").concat(record.bytes));
    }
    const payload = decodePack(record);
    validatePack(payload);
    return payload;
  }
  async function removePack(db2, id) {
    await deletePack(db2, id);
    if (await getActivePackId(db2) === id) {
      const rest = [...await getDownloadedPackIds(db2)];
      await setActivePackId(db2, rest.length ? rest[0] : null);
    }
  }

  // app/js/db/ext-loader.js
  var EXT_CACHE = "neobridge-ext";
  var BODY_URL = "./data/ext.v1.json";
  var MANIFEST_URL = "./data/manifest-ext.json";
  function decideExt({ manifestSha, storedSha, hasBody }) {
    const desired = manifestSha || storedSha;
    if (!desired) return { action: "unavailable", sha: null };
    if (desired === storedSha && hasBody) return { action: "use-cache", sha: desired };
    if (hasBody) return { action: "refresh", sha: desired };
    return { action: "fetch", sha: desired };
  }
  function parseExt(text, meta) {
    const payload = JSON.parse(text);
    if (!payload || typeof payload.words !== "object" || Object.keys(payload.words).length !== payload.count) {
      throw new Error("\u6269\u5C55\u6570\u636E\u7ED3\u6784\u4E0D\u81EA\u6D3D");
    }
    return {
      map: new Map(Object.entries(payload.words)),
      extVersion: payload.extVersion,
      count: payload.count,
      sha256: meta.sha,
      fromCache: !!meta.fromCache
    };
  }
  async function loadExt({ fetchImpl, cachesOk } = {}) {
    try {
      const f = fetchImpl || (typeof fetch === "function" ? fetch : null);
      if (!f) return null;
      const hasCaches = cachesOk !== void 0 ? cachesOk : typeof caches !== "undefined";
      let manifestSha = null;
      let manifest = null;
      try {
        const res = await f(MANIFEST_URL);
        if (res.ok) {
          manifest = await res.json();
          if (typeof manifest.sha256 === "string") manifestSha = manifest.sha256;
        }
      } catch {
      }
      let storedSha = null;
      let bodyText = null;
      if (hasCaches) {
        try {
          const cache = await caches.open(EXT_CACHE);
          const metaRes = await cache.match(MANIFEST_URL);
          if (metaRes) {
            const stored = await metaRes.json();
            if (typeof stored.sha256 === "string") storedSha = stored.sha256;
          }
          const bodyRes = await cache.match(BODY_URL);
          if (bodyRes) bodyText = await bodyRes.text();
        } catch {
        }
      }
      const plan = decideExt({ manifestSha, storedSha, hasBody: bodyText != null });
      if (plan.action === "unavailable") return null;
      if (plan.action === "use-cache") return parseExt(bodyText, { sha: plan.sha, fromCache: true });
      try {
        const res = await f(BODY_URL);
        if (!res.ok) throw new Error("HTTP ".concat(res.status));
        const buffer = await res.arrayBuffer();
        const sha = await sha256Hex(buffer);
        if (sha !== plan.sha) throw new Error("sha256 \u4E0D\u7B26\uFF08\u6B63\u6587 ".concat(sha.slice(0, 12), " \u2260 \u76EE\u6807 ").concat(plan.sha.slice(0, 12), "\uFF09"));
        const text = new TextDecoder("utf-8").decode(buffer);
        if (hasCaches) {
          try {
            const cache = await caches.open(EXT_CACHE);
            await cache.put(BODY_URL, new Response(text, { headers: { "Content-Type": "application/json" } }));
            if (manifest) {
              await cache.put(MANIFEST_URL, new Response(JSON.stringify(manifest), { headers: { "Content-Type": "application/json" } }));
            }
          } catch (err) {
            console.warn("\u6269\u5C55\u6570\u636E\u5199\u7F13\u5B58\u5931\u8D25\uFF08\u672C\u6B21\u4ECD\u53EF\u7528\uFF09\uFF1A", err);
          }
        }
        return parseExt(text, { sha: plan.sha, fromCache: false });
      } catch (err) {
        if (bodyText != null) {
          console.warn("\u62C9\u53D6\u6269\u5C55\u6570\u636E\u5931\u8D25\uFF0C\u9000\u56DE\u672C\u5730\u65E7\u7248\uFF1A", err);
          return parseExt(bodyText, { sha: storedSha, fromCache: true });
        }
        console.warn("\u6269\u5C55\u6570\u636E\u4E0D\u53EF\u7528\uFF1A", err);
        return null;
      }
    } catch (err) {
      console.warn("\u6269\u5C55\u6570\u636E\u52A0\u8F7D\u5F02\u5E38\uFF08\u4E0D\u5F71\u54CD\u8BCD\u5305\uFF09\uFF1A", err);
      return null;
    }
  }

  // app/js/ui/audio-download.js
  var AUDIO_CACHE = "neobridge-audio-v1";
  var MIN_BYTES = 500;
  function audioUrl(name) {
    return "./audio/".concat(name, ".mp3");
  }
  function audioNamesOf(payload) {
    const set = /* @__PURE__ */ new Set();
    for (const word of (payload == null ? void 0 : payload.words) || []) {
      for (const sense of word.senses || []) if (sense.a) set.add(sense.a);
    }
    return [...set].sort();
  }
  async function countCached(names) {
    if (typeof caches === "undefined") return 0;
    const cache = await caches.open(AUDIO_CACHE);
    const keys = await cache.keys();
    const have = new Set(keys.map((k) => nameOf(k.url)));
    return names ? names.filter((n) => have.has(n)).length : have.size;
  }
  function nameOf(url) {
    const path = new URL(url).pathname;
    const base = path.slice(path.lastIndexOf("/") + 1);
    return base.endsWith(".mp3") ? base.slice(0, -4) : base;
  }
  async function downloadAudio(names, options = {}) {
    const { concurrency = 6, onProgress = null } = options;
    const cache = await caches.open(AUDIO_CACHE);
    const queue = [...names];
    const state = {
      total: names.length,
      done: 0,
      ok: 0,
      skipped: 0,
      failed: [],
      bytes: 0
    };
    const tick = () => {
      state.done += 1;
      if (onProgress) onProgress(state);
    };
    async function worker() {
      for (; ; ) {
        const name = queue.shift();
        if (!name) return;
        const url = audioUrl(name);
        try {
          if (await cache.match(url)) {
            state.skipped += 1;
            tick();
            continue;
          }
          const res = await fetch(url);
          if (!res.ok) throw new Error("HTTP ".concat(res.status));
          const buf = await res.arrayBuffer();
          if (buf.byteLength < MIN_BYTES) throw new Error("\u53EA\u6709 ".concat(buf.byteLength, " \u5B57\u8282"));
          await cache.put(url, new Response(buf, { headers: { "Content-Type": "audio/mpeg" } }));
          state.bytes += buf.byteLength;
          state.ok += 1;
        } catch (err) {
          state.failed.push({ name, reason: (err == null ? void 0 : err.message) || String(err) });
        }
        tick();
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length || 1) }, worker));
    return state;
  }
  var player = null;
  var lastNames = null;
  var cursor = 0;
  function pick(names) {
    const key = names.join("|");
    if (key !== lastNames) {
      lastNames = key;
      cursor = 0;
    }
    const name = names[cursor % names.length];
    cursor += 1;
    return name;
  }
  function playAudio(names) {
    if (!names || !names.length) return;
    const name = pick(names);
    if (!player) player = new Audio();
    player.src = audioUrl(name);
    player.currentTime = 0;
    const playing = player.play();
    if (playing && playing.catch) {
      playing.catch((err) => {
        console.warn("\u53D1\u97F3\u64AD\u653E\u5931\u8D25\uFF1A", name, err);
        alert("\u53D1\u97F3\u6682\u65F6\u65E0\u6CD5\u64AD\u653E\uFF1A\n\u65E2\u6CA1\u6709\u4E0B\u8F7D\u5230\u672C\u5730\uFF0C\u5F53\u524D\u4E5F\u4E0D\u5728\u7EBF\u3002\n\n\u53EF\u5728\u300C\u8BBE\u7F6E \u2192 \u53D1\u97F3\u300D\u4E00\u6B21\u6027\u4E0B\u8F7D\u5168\u90E8\u53D1\u97F3\u3002");
      });
    }
  }
  function audioNamesOfWord(word) {
    const seen = [];
    for (const sense of (word == null ? void 0 : word.senses) || []) {
      if (sense.a && !seen.includes(sense.a)) seen.push(sense.a);
    }
    return seen;
  }

  // app/js/ui/card-info.js
  var POS_ZH = Object.freeze({
    noun: "\u540D\u8BCD",
    verb: "\u52A8\u8BCD",
    adjective: "\u5F62\u5BB9\u8BCD",
    adverb: "\u526F\u8BCD",
    phrase: "\u77ED\u8BED",
    "phrasal verb": "\u77ED\u8BED\u52A8\u8BCD",
    preposition: "\u4ECB\u8BCD",
    pronoun: "\u4EE3\u8BCD",
    conjunction: "\u8FDE\u8BCD",
    determiner: "\u9650\u5B9A\u8BCD",
    "modal verb": "\u60C5\u6001\u52A8\u8BCD",
    exclamation: "\u611F\u53F9\u8BCD",
    number: "\u6570\u8BCD",
    "auxiliary verb": "\u52A9\u52A8\u8BCD"
  });
  function posTitle(pos) {
    return POS_ZH[pos] || pos || "";
  }
  function distinctPos(word) {
    const seen = [];
    for (const sense of (word == null ? void 0 : word.senses) || []) {
      if (sense.pos && !seen.includes(sense.pos)) seen.push(sense.pos);
    }
    return seen;
  }
  function showGrouping(word) {
    return distinctPos(word).length > 1;
  }
  function lenClass(word) {
    const n = ((word == null ? void 0 : word.w) || "").length;
    if (n <= 6) return "len-s";
    if (n <= 12) return "len-m";
    if (n <= 20) return "len-l";
    return "len-xl";
  }
  var norm = (s) => (s || "").trim().toLowerCase();
  function keywordText(word) {
    const seen = [];
    for (const sense of (word == null ? void 0 : word.senses) || []) {
      const hw = sense.hw;
      if (hw && norm(hw) !== norm(word == null ? void 0 : word.w) && !seen.includes(hw)) seen.push(hw);
    }
    return seen;
  }
  function youglishUrl(word) {
    return "https://youglish.com/pronounce/".concat(encodeURIComponent((word == null ? void 0 : word.w) || ""), "/english/uk");
  }
  function senseUrl(baseUrl, sense) {
    return "".concat(baseUrl || "").concat((sense == null ? void 0 : sense.refid) || "");
  }
  var REL_ZH = Object.freeze({ derived: "\u6D3E\u751F", sibling: "\u540C\u65CF" });
  function extSummary(ext) {
    const parts = ["\u4E2D\u6587\u8BE6\u89E3"];
    const ety = ext && ext.etymology || {};
    if (ety.origin || ety.story || (ety.path || []).length) parts.push("\u8BCD\u6E90");
    if ((ext && ext.family || []).length) parts.push("\u5BB6\u65CF");
    return "\u6269\u5C55\u4FE1\u606F \xB7 ".concat(parts.join(" / "));
  }
  function extPathText(path) {
    return (path || []).map((p) => "".concat(p.form, "\uFF08").concat(p.lang, "\xB7").concat(p.meaning, "\uFF09")).join(" \u2192 ");
  }
  function extFamilyLabel(item) {
    const rel = REL_ZH[item.rel] || item.rel || "";
    const pos = posTitle(item.pos);
    return [rel, pos].filter(Boolean).join("\xB7");
  }

  // app/js/ui/views.js
  var EXT = { target: "_blank", rel: "noopener" };
  function replaceChildren(el, ...nodes) {
    while (el.firstChild) el.removeChild(el.firstChild);
    for (const node of nodes) el.append(node);
  }
  function h(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value == null) continue;
      if (key === "class") node.className = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value);
    }
    for (const child of children.flat(9)) {
      if (child == null) continue;
      node.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return node;
  }
  var ANSWERS = Object.freeze([
    { label: "\u719F\u6089", signal: "right", cls: "ok" },
    { label: "\u4E00\u822C", signal: "fuzzy", cls: "mid" },
    { label: "\u6807\u8BB0", signal: "wrong", cls: "no" }
  ]);
  var FLIP_LABEL = "\u5F00";
  function front(word, onPlay) {
    const ipas = [...new Set(word.senses.map((s) => s.ipa).filter(Boolean))].slice(0, 2);
    const posList = distinctPos(word);
    const keywords = keywordText(word);
    const audios = audioNamesOfWord(word);
    const n = word.senses.length;
    return h(
      "div",
      { class: "q-front" },
      h(
        "p",
        { class: "q-tags" },
        posList.map((pos) => h("span", { class: "tag", title: posTitle(pos) }, pos)),
        n > 1 ? h("span", { class: "tag", title: "".concat(n, " \u4E2A\u4E49\u9879") }, "".concat(n, " \u4E49\u9879")) : null
      ),
      h("p", { class: "q-word ".concat(lenClass(word)) }, word.w),
      // 读音行恒定：有音标就显示音标，喇叭始终在后面；无音标只剩喇叭
      h(
        "p",
        { class: "q-sound" },
        ipas.length ? h("span", { class: "q-ipa" }, ipas.map((i) => "/".concat(i, "/")).join("   ")) : null,
        audios.length ? h("button", {
          class: "q-bell",
          type: "button",
          title: "\u672C\u5730\u53D1\u97F3",
          onclick: () => onPlay && onPlay(audios)
        }, "\u{1F50A}") : h("a", { class: "q-bell", href: youglishUrl(word), title: "YouGlish \u771F\u5B9E\u53D1\u97F3", ...EXT }, "\u{1F50A}")
      ),
      keywords.length ? h("p", { class: "q-key" }, "Keyword\uFF1A", keywords.join(" / ")) : null
    );
  }
  function senseBlock(baseUrl, sense, withPos) {
    return h(
      "div",
      { class: "sense" },
      h(
        "p",
        { class: "sense-meta" },
        h("span", { class: "lvl" }, sense.level),
        withPos && sense.pos ? [" \xB7 ", h("span", { class: "meta-pos", title: posTitle(sense.pos) }, sense.pos)] : null,
        sense.topic ? " \xB7 ".concat(sense.topic) : "",
        " \xB7 ",
        // 链接文本用义项自己的词头（短语卡各义项词头可能不同，如 humour / sense）
        h("a", { class: "sense-link", href: senseUrl(baseUrl, sense), ...EXT }, sense.hw, " \u2197")
      ),
      h("p", { class: "sense-def" }, sense.def),
      sense.guide ? h("p", { class: "sense-guide" }, sense.guide) : null,
      (sense.ex || []).slice(0, 2).map((ex) => h("p", { class: "sense-ex" }, "\u201C".concat(ex, "\u201D")))
    );
  }
  function extBlock(ext) {
    const ety = ext && ext.etymology || {};
    const path = ety.path || [];
    const family = ext && ext.family || [];
    return h(
      "details",
      { class: "q-ext" },
      h("summary", null, extSummary(ext)),
      h(
        "div",
        { class: "ext-body" },
        ext.zh ? h("p", { class: "ext-zh" }, ext.zh) : null,
        ety.origin ? h("p", { class: "ext-origin" }, "\u8BCD\u6E90\uFF1A", ety.origin) : null,
        path.length ? h("p", { class: "ext-path" }, extPathText(path)) : null,
        ety.story ? h(
          "details",
          { class: "ext-story" },
          h("summary", null, "\u6F14\u53D8\u6545\u4E8B \xB7 ".concat(ety.story.length, " \u5B57")),
          h("p", null, ety.story)
        ) : null,
        family.length ? h("div", { class: "ext-fam" }, family.map((f) => h("span", {
          class: "ext-chip",
          title: extFamilyLabel(f) || null
        }, h("b", null, f.w), " ".concat(f.zh)))) : null
      )
    );
  }
  function back(word, baseUrl, ext) {
    const grouped = showGrouping(word);
    return h(
      "div",
      { class: "q-back" },
      grouped ? distinctPos(word).map((pos) => h(
        "div",
        { class: "pos-group" },
        h("p", { class: "pos-head" }, h("span", { class: "tag", title: posTitle(pos) }, pos)),
        word.senses.filter((s) => s.pos === pos).map((s) => senseBlock(baseUrl, s, false))
      )) : word.senses.map((s) => senseBlock(baseUrl, s, true)),
      ext ? extBlock(ext) : null
    );
  }
  function questionView({ word, baseUrl, flipped, onFlip, onAnswer, onPlay, ext }) {
    const root = h("div", { class: "q" }, front(word, onPlay));
    if (flipped) root.append(back(word, baseUrl, ext));
    root.append(h(
      "div",
      { class: "q-actions" },
      flipped ? ANSWERS.map((a) => h("button", { class: "btn wide ans ".concat(a.cls), onclick: () => onAnswer(a.signal) }, a.label)) : h("button", { class: "btn wide", onclick: onFlip }, FLIP_LABEL)
    ));
    return root;
  }
  function detailView(word, baseUrl, ext, onPlay) {
    const root = h("div", { class: "q" }, front(word, onPlay));
    root.append(back(word, baseUrl, ext));
    return root;
  }
  function fitWord(root) {
    const el = root.querySelector(".q-word");
    if (!el) return;
    el.style.fontSize = "";
    const avail = el.clientWidth;
    if (!avail) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    const natural = range.getBoundingClientRect().width;
    if (!(natural > avail)) return;
    const cap = parseFloat(getComputedStyle(el).fontSize);
    if (!cap) return;
    el.style.fontSize = "".concat(Math.floor(cap * (avail / natural) * 10) / 10, "px");
  }
  function summaryView({ total, counts, wrongWords, onPractice, onExit }) {
    const rows = [
      ["\u5B8C\u6210\u9898\u6570", String(total)],
      ["\u719F\u6089", String(counts.right)],
      ["\u4E00\u822C", String(counts.fuzzy)],
      ["\u6807\u8BB0", String(counts.wrong)]
    ];
    const list = h(
      "ul",
      { class: "wrong-list" },
      wrongWords.map((w) => {
        var _a, _b;
        return h("li", null, h("strong", null, w.w), " \u2014 ", (_b = (_a = w.senses[0]) == null ? void 0 : _a.def) != null ? _b : "");
      })
    );
    return h(
      "div",
      { class: "q summary" },
      h("p", { class: "q-word" }, "\u672C\u8F6E\u5B8C\u6210"),
      h(
        "dl",
        { class: "sum-list" },
        rows.flatMap(([k, v]) => [h("dt", null, k), h("dd", null, v)])
      ),
      wrongWords.length ? h(
        "div",
        { class: "wrong-block" },
        h("p", { class: "wrong-title" }, "\u6807\u8BB0\u7684\u8BCD\uFF08".concat(wrongWords.length, "\uFF09")),
        list
      ) : null,
      h(
        "div",
        { class: "q-actions" },
        wrongWords.length ? h("button", { class: "btn primary wide", onclick: onPractice }, "\u91CD\u7EC3\u8FD9\u4E9B\u8BCD") : null,
        h("button", { class: "btn wide", onclick: onExit }, "\u56DE\u5230\u9996\u9875")
      )
    );
  }

  // app/js/ui/lists.js
  var WEEK_DAYS = 7;
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
    }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.top = "-9999px";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, text.length);
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
  async function copyWithFeedback(btn, text) {
    const ok = await copyText(text);
    const label = btn.textContent;
    btn.textContent = ok ? "\u5DF2\u590D\u5236" : "\u590D\u5236\u5931\u8D25";
    setTimeout(() => {
      btn.textContent = label;
    }, 1500);
  }
  var byWrongFirst = (a, b) => (b.wrong ? 1 : 0) - (a.wrong ? 1 : 0) || a.at - b.at;
  function wordLine(word, extra) {
    var _a, _b, _c;
    const def = (_b = (_a = word == null ? void 0 : word.senses) == null ? void 0 : _a[0]) == null ? void 0 : _b.def;
    return h(
      "li",
      null,
      h("strong", null, (_c = word == null ? void 0 : word.w) != null ? _c : "?"),
      extra,
      def ? h("span", { class: "def" }, def) : null
    );
  }
  function collapsible(head, body) {
    let open = false;
    const caret = h("span", { class: "caret" }, "\u25B8");
    const sync = () => {
      body.hidden = !open;
      caret.textContent = open ? "\u25BE" : "\u25B8";
    };
    head.addEventListener("click", () => {
      open = !open;
      sync();
    });
    sync();
    return caret;
  }
  function renderWeek(card, rows, byKey) {
    const today = dayKey(Date.now());
    const days = [];
    const base = /* @__PURE__ */ new Date();
    for (let i = 0; i < WEEK_DAYS; i++) {
      days.push(dayKey(new Date(base.getFullYear(), base.getMonth(), base.getDate() - i)));
    }
    replaceChildren(card, h("h2", null, "\u6700\u8FD1 7 \u5929"));
    for (const day of days) {
      const items = rows.filter((r) => r.day === day && byKey.has(r.k)).sort(byWrongFirst);
      card.append(dayCard(day, items, byKey, day === today));
    }
  }
  function dayCard(day, items, byKey, isToday) {
    const count = items.length;
    const text = items.map((r) => byKey.get(r.k).w).join("; ");
    const title = h(
      "span",
      { class: "day-title" },
      "".concat(dayLabel(day)).concat(isToday ? "\uFF08\u4ECA\u5929\uFF09" : "").concat(count ? " \xB7 ".concat(count) : "")
    );
    const head = h(
      "div",
      { class: "day-head" },
      title,
      count ? h("button", {
        class: "btn ghost",
        onclick: (e) => {
          e.stopPropagation();
          copyWithFeedback(e.currentTarget, text);
        }
      }, "\u590D\u5236") : null
    );
    const body = count ? h("ul", { class: "day-list" }, items.map((r) => wordLine(byKey.get(r.k), r.wrong ? h("span", { class: "flag", title: "\u8FD9\u5929\u7EC3\u9519\u4E86" }, "\u25CF") : null))) : null;
    if (count) title.append(collapsible(head, body));
    return h("div", { class: "day-card" + (count ? "" : " empty") }, head, body);
  }
  function renderWrongList(card, entries, byKey, onPractice) {
    const title = h("h2", null, entries.length ? "\u5F3A\u5316\u8BB0\u5FC6 \xB7 ".concat(entries.length) : "\u5F3A\u5316\u8BB0\u5FC6");
    const head = h(
      "div",
      { class: "day-head wrong-head" },
      title,
      entries.length && onPractice ? h("button", {
        class: "btn ghost",
        // 头部整体可点（折叠），按钮必须拦住冒泡，否则点了会顺带展开
        onclick: (e) => {
          e.stopPropagation();
          onPractice();
        }
      }, "\u590D\u7EC3\u5168\u90E8") : null
    );
    const body = entries.length ? h(
      "ul",
      { class: "wrong-full" },
      entries.map((e) => wordLine(byKey.get(e.k), h("span", { class: "when" }, relDay(e.lastWrongAt))))
    ) : h("p", { class: "day-empty" }, "\u6682\u65E0");
    if (entries.length) title.append(collapsible(head, body));
    replaceChildren(card, head, body);
  }
  function dictEntry(word, onSelect) {
    const ipa = word.senses.map((s) => s.ipa).filter(Boolean)[0] || null;
    const open = () => onSelect(word);
    return h(
      "li",
      {
        class: "dict-hit",
        role: "button",
        tabindex: "0",
        onclick: open,
        onkeydown: (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            open();
          }
        }
      },
      h(
        "p",
        { class: "dict-head" },
        h("strong", { class: "dict-word" }, word.w),
        ipa ? h("span", { class: "dict-ipa" }, "/".concat(ipa, "/")) : null,
        distinctPos(word).map((pos) => h("span", { class: "tag", title: posTitle(pos) }, pos)),
        h("span", { class: "dict-go", "aria-hidden": "true" }, "\u203A")
      ),
      word.senses.map((s) => h(
        "p",
        { class: "dict-sense" },
        h("span", { class: "lvl" }, s.level),
        s.guide ? h("span", { class: "dict-guide" }, s.guide) : null,
        s.def
      ))
    );
  }
  function renderDictList(listEl, hits, onSelect) {
    replaceChildren(listEl, ...hits.map((w) => dictEntry(w, onSelect)));
  }

  // app/js/core/weight.js
  function topLevel(levels) {
    return (levels || []).slice().sort().pop() || null;
  }
  function wordWeight(word, state, params2) {
    var _a, _b, _c;
    const level = (_a = params2.levelWeight[topLevel(word.levels)]) != null ? _a : 1;
    const mastery = state ? (_b = state.mastery) != null ? _b : 0 : 0;
    const masteryFactor = Math.pow(1 - mastery, params2.masteryExponent);
    const timesSeen = state ? (_c = state.timesSeen) != null ? _c : 0 : 0;
    const freshness = 1 / (1 + params2.freshnessDecay * timesSeen);
    return level * masteryFactor * freshness;
  }

  // app/js/core/scheduler.js
  function buildPools({ words, states, params: params2, sessionSeen }) {
    const pools = { new: [], err: [], rev: [] };
    for (const word of words) {
      if (sessionSeen && sessionSeen.has(word.k)) continue;
      pools[poolOf(states[word.k], params2)].push(word);
    }
    return pools;
  }
  function availablePools(pools) {
    return POOLS.filter((p) => pools[p].length > 0);
  }
  function poolProbabilities({ words, states, params: params2, coverage, sessionSeen }) {
    const pools = buildPools({ words, states, params: params2, sessionSeen });
    const available = availablePools(pools);
    if (!available.length) return { pools, probs: null };
    return { pools, probs: normalizeQuotas(quotasFor(coverage, params2), available) };
  }
  function pickWeighted(pool, states, params2, rng) {
    const weights = pool.map((w) => wordWeight(w, states[w.k], params2));
    const total = weights.reduce((a, b) => a + b, 0);
    if (!(total > 0)) return pool[Math.floor(rng() * pool.length)];
    let r = rng() * total;
    for (let i = 0; i < pool.length; i++) {
      r -= weights[i];
      if (r <= 0) return pool[i];
    }
    return pool[pool.length - 1];
  }
  function pickNext({ words, states, params: params2, coverage, sessionSeen, rng = Math.random }) {
    const { pools, probs } = poolProbabilities({ words, states, params: params2, coverage, sessionSeen });
    if (!probs) return null;
    const draw = rng();
    let acc = 0;
    let chosen = null;
    for (const p of POOLS) {
      if (!(probs[p] > 0)) continue;
      acc += probs[p];
      if (draw < acc) {
        chosen = p;
        break;
      }
    }
    if (!chosen) chosen = POOLS.find((p) => probs[p] > 0);
    return { word: pickWeighted(pools[chosen], states, params2, rng), pool: chosen, probs };
  }

  // app/js/core/queue.js
  function buildQueue({ words, states, params: params2, size, rng = Math.random }) {
    if (!words || !words.length || size <= 0) return [];
    const coverage = coverageOf(states, words);
    const sessionSeen = /* @__PURE__ */ new Set();
    const queue = [];
    for (let i = 0; i < size; i++) {
      const picked = pickNext({ words, states, params: params2, coverage, sessionSeen, rng });
      if (!picked) break;
      sessionSeen.add(picked.word.k);
      queue.push({ k: picked.word.k, pool: picked.pool });
    }
    return queue;
  }

  // app/js/ui/session.js
  var activeCard = null;
  if (typeof window !== "undefined") {
    window.addEventListener("resize", () => {
      if (activeCard) fitWord(activeCard);
    });
  }
  function openSession({
    db: db2,
    words,
    baseUrl,
    states,
    size,
    host,
    onExit,
    onPlay = playAudio,
    extMap = null,
    params: params2 = withParams(),
    now = () => Date.now(),
    rng = Math.random
  }) {
    const byKey = new Map(words.map((w) => [w.k, w]));
    const results = [];
    let queue = [];
    let index = 0;
    let flipped = false;
    let answered = null;
    async function answer(signal) {
      if (answered) return;
      answered = signal;
      const k = queue[index].k;
      const t = now();
      const prev = states[k] || createState(t, k);
      const nextState = applyAnswer(markSeen(prev, t), signal, t, params2);
      states[k] = nextState;
      results.push({ k, signal });
      try {
        await saveProgress(db2, nextState);
        await saveDaily(db2, { day: dayKey(t), k, at: t, wrong: signal === SIGNAL.WRONG });
      } catch (err) {
        console.warn("\u8FDB\u5EA6\u5199\u5165\u5931\u8D25\uFF1A", err);
      }
      next();
    }
    function next() {
      index += 1;
      flipped = false;
      answered = null;
      paint();
    }
    function summary() {
      const counts = { right: 0, fuzzy: 0, wrong: 0 };
      const wrongWords = [];
      for (const r of results) {
        counts[r.signal] += 1;
        if (r.signal === "wrong") wrongWords.push(byKey.get(r.k));
      }
      return { total: results.length, counts, wrongWords };
    }
    function practice() {
      const { wrongWords } = summary();
      if (wrongWords.length) start(wrongWords, wrongWords.length);
    }
    function start(candidates, n) {
      queue = buildQueue({ words: candidates, states, params: params2, size: n, rng });
      index = 0;
      flipped = false;
      answered = null;
      results.length = 0;
      paint();
    }
    function header() {
      return h(
        "div",
        { class: "session-head" },
        h("span", null, "".concat(index + 1, " / ").concat(queue.length)),
        h("button", { class: "btn ghost", onclick: () => onExit() }, "\u9000\u51FA")
      );
    }
    function paint() {
      replaceChildren(host);
      if (index >= queue.length) {
        const data = summary();
        activeCard = null;
        host.append(summaryView({
          ...data,
          onPractice: practice,
          onExit: () => onExit()
        }));
        return;
      }
      const card = questionView({
        word: byKey.get(queue[index].k),
        baseUrl,
        flipped,
        ext: extMap ? extMap.get(queue[index].k) : null,
        onFlip: () => {
          flipped = true;
          paint();
        },
        onAnswer: answer,
        onPlay
      });
      host.append(header(), card);
      activeCard = card;
      fitWord(card);
    }
    start(words, size);
  }

  // app/js/app.js
  var BUNDLED_BASE = "./data/";
  var params = withParams();
  var IS_LEGACY = !document.querySelector('link[rel="manifest"]');
  var $ = (id) => document.getElementById(id);
  var modeSwitch = document.querySelector(".classic-link");
  if (modeSwitch) {
    modeSwitch.classList.toggle("on", IS_LEGACY);
    modeSwitch.title = IS_LEGACY ? "\u5F53\u524D\uFF1A\u7ECF\u5178\u7248 \xB7 \u70B9\u6309\u5207\u56DE\u6F6E\u6D41\u7248" : "\u5F53\u524D\uFF1A\u6F6E\u6D41\u7248 \xB7 \u70B9\u6309\u5207\u6362\u7ECF\u5178\u7248";
    modeSwitch.setAttribute("aria-label", modeSwitch.title);
  }
  function showError(prefix, err) {
    console.error(err);
    const el = $("detail");
    el.hidden = false;
    el.textContent = "".concat(prefix).concat((err == null ? void 0 : err.stack) || (err == null ? void 0 : err.message) || String(err));
  }
  function setStatus(text, isError = false) {
    const el = $("status");
    el.textContent = text;
    el.classList.toggle("error", isError);
  }
  function fmtBytes(n) {
    return n >= 1024 * 1024 ? "".concat((n / 1024 / 1024).toFixed(2), " MB") : "".concat(Math.round(n / 1024), " KB");
  }
  var db = null;
  var view = { packs: [], activeId: null, payload: null, progress: {}, ext: null };
  var audioNames = [];
  function renderPacks() {
    $("pack-card").hidden = false;
    const list = $("pack-list");
    replaceChildren(list);
    if (!view.packs.length) {
      const li = document.createElement("li");
      li.textContent = "\u672C\u5730\u8FD8\u6CA1\u6709\u8BCD\u5305\uFF0C\u70B9\u4E0B\u9762\u7684\u6309\u94AE\u4E0B\u8F7D\u3002";
      list.append(li);
      return;
    }
    for (const { record } of view.packs) {
      const active = record.id === view.activeId;
      const li = document.createElement("li");
      const name = document.createElement("div");
      name.className = "pack-name";
      name.append("".concat(record.packId, " v").concat(record.version));
      const meta = document.createElement("small");
      meta.textContent = "".concat(record.levels.join("/"), " \xB7 ").concat(record.wordCount, " \u8BCD \xB7 ").concat(record.senseCount, " \u4E49\u9879 \xB7 ") + "".concat(fmtBytes(record.bytes), " \xB7 sha ").concat(record.sha256.slice(0, 12));
      name.append(meta);
      li.append(name);
      const badge = document.createElement("span");
      badge.className = "badge" + (active ? " on" : "");
      badge.textContent = active ? "\u5F53\u524D" : "";
      li.append(badge);
      if (!active) {
        const use = document.createElement("button");
        use.textContent = "\u4F7F\u7528";
        use.onclick = async () => {
          await setActivePackId(db, record.id);
          await refresh();
        };
        li.append(use);
      }
      const del2 = document.createElement("button");
      del2.className = "danger";
      del2.textContent = "\u5220\u9664";
      del2.title = "\u5220\u9664\u672C\u5730\u8BB0\u5F55\uFF0C\u91CD\u65B0\u4E0B\u8F7D\u5373\u53EF\u66F4\u65B0";
      del2.onclick = async () => {
        if (!confirm("\u5220\u9664\u8BCD\u5305 ".concat(record.packId, " v").concat(record.version, "\uFF1F\n\uFF08\u8FDB\u5EA6\u4E0D\u4F1A\u88AB\u6E05\u9664\uFF09"))) return;
        await removePack(db, record.id);
        await refresh();
      };
      li.append(del2);
      list.append(li);
    }
  }
  function renderStats() {
    const card = $("stat-card");
    if (!view.payload) {
      card.hidden = true;
      return;
    }
    card.hidden = false;
    const words = view.payload.words;
    const answered = words.filter((w) => {
      var _a;
      return ((_a = view.progress[w.k]) == null ? void 0 : _a.lastResult) != null;
    }).length;
    const coverage = coverageOf(view.progress, words);
    const trained = Object.keys(view.progress).length;
    $("stat-list").innerHTML = "";
    const rows = [
      ["\u8BCD\u5305", "".concat(view.payload.packId, " v").concat(view.payload.version)],
      ["\u8BCD/\u4E49", "".concat(words.length, " / ").concat(view.payload.senseCount)],
      ["\u5237\u8FC7", "".concat(answered, "\uFF08").concat((coverage * 100).toFixed(1), "%\uFF09")],
      ["\u603B\u8FDB\u5EA6", "".concat(trained, "\uFF08\u542B\u5176\u5B83\u5305\uFF09")]
    ];
    for (const [k, v] of rows) {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = v;
      $("stat-list").append(dt, dd);
    }
    $("meter-fill").style.width = "".concat(coverage * 100, "%");
  }
  async function renderAudio() {
    const card = $("audio-card");
    const hint = $("audio-hint");
    const btn = $("btn-audio");
    if (IS_LEGACY || !view.payload) {
      card.hidden = true;
      return;
    }
    card.hidden = false;
    audioNames = audioNamesOf(view.payload);
    if (!audioNames.length) {
      btn.disabled = true;
      $("audio-fill").style.width = "0";
      hint.classList.add("error");
      hint.textContent = "\u5F53\u524D\u8BCD\u5305 ".concat(view.payload.packId, " v").concat(view.payload.version, " \u4E0D\u542B\u53D1\u97F3\u6570\u636E\uFF08\u53D1\u97F3\u4ECE v2 \u8D77\u624D\u5185\u7F6E\uFF09\u3002") + "\u8BF7\u5728\u4E0A\u9762\u300C\u8BCD\u5305\u300D\u91CC\u70B9\u300C\u5220\u9664\u300D\uFF0C\u518D\u70B9\u300C\u4E0B\u8F7D\u5185\u7F6E\u8BCD\u5305\u300D\u6362\u6210\u6700\u65B0\u7248\u3002";
      setStatus("\u8BCD\u5305 ".concat(view.payload.packId, " v").concat(view.payload.version, " \u4E0D\u542B\u53D1\u97F3 \u2014\u2014 \u5220\u9664\u540E\u91CD\u65B0\u4E0B\u8F7D"), true);
      return;
    }
    btn.disabled = false;
    hint.classList.remove("error");
    const have = await countCached(audioNames);
    hint.textContent = "".concat(audioNames.length, " \u4E2A\u53D1\u97F3\u6587\u4EF6 \xB7 \u5DF2\u4E0B\u8F7D ").concat(have);
    $("audio-fill").style.width = "".concat(have / audioNames.length * 100, "%");
  }
  async function renderLists() {
    const has = !!view.payload;
    $("week-card").hidden = !has;
    $("wrong-card").hidden = !has;
    if (!has) return;
    const byKey = new Map(view.payload.words.map((w) => [w.k, w]));
    const days = lastDays(7);
    const rows = await loadDaily(db, days[0], days[days.length - 1]);
    renderWeek($("week-card"), rows, byKey);
    const wrongWords = view.payload.words.filter((w) => isWrongWord(view.progress[w.k], params));
    const entries = wrongWords.map((w) => {
      var _a;
      return { k: w.k, lastWrongAt: (_a = view.progress[w.k].lastWrongAt) != null ? _a : 0 };
    }).sort((a, b) => a.lastWrongAt - b.lastWrongAt);
    const order = entries.map((e) => byKey.get(e.k));
    renderWrongList($("wrong-card"), entries, byKey, () => startSession(order.length, order));
  }
  var DICT_LIMIT = 50;
  var dictDetailKey = null;
  function drawDictResults() {
    const list = $("dict-list");
    const hint = $("dict-hint");
    if (!view.payload) return;
    const q = $("dict-q").value;
    if (!q.trim()) {
      replaceChildren(list);
      hint.textContent = "".concat(view.payload.words.length, " \u8BCD \xB7 \u8F93\u5165\u82F1\u6587\u5F00\u59CB\u67E5\u8BE2\uFF08\u5927\u5C0F\u5199\u4E0D\u654F\u611F\uFF0C\u542B\u77ED\u8BED\uFF09");
      return;
    }
    const hits = searchWords(view.payload.words, q);
    if (!hits.length) {
      replaceChildren(list);
      hint.textContent = "\u6CA1\u6709\u5339\u914D\u300C".concat(q.trim(), "\u300D\u7684\u8BCD");
      return;
    }
    hint.textContent = hits.length > DICT_LIMIT ? "".concat(hits.length, " \u4E2A\u5339\u914D \xB7 \u663E\u793A\u524D ").concat(DICT_LIMIT) : "".concat(hits.length, " \u4E2A\u5339\u914D");
    renderDictList(list, hits.slice(0, DICT_LIMIT), openDictDetail);
  }
  function renderDictDetail() {
    const card = $("dict-detail");
    const word = view.payload && view.payload.words.find((w) => w.k === dictDetailKey);
    if (!word) {
      dictDetailKey = null;
      card.hidden = true;
      $("dict-card").hidden = !view.payload;
      if (view.payload) drawDictResults();
      return;
    }
    replaceChildren(
      card,
      h("button", { class: "btn ghost dict-back", onclick: closeDictDetail }, "\u2190 \u8FD4\u56DE\u5217\u8868"),
      detailView(
        word,
        view.payload.baseUrl,
        view.ext ? view.ext.map.get(word.k) : null,
        playAudio
      )
    );
    card.hidden = false;
    $("dict-card").hidden = true;
  }
  function openDictDetail(word) {
    dictDetailKey = word.k;
    renderDictDetail();
    window.scrollTo(0, 0);
  }
  function closeDictDetail() {
    dictDetailKey = null;
    renderDictDetail();
  }
  function renderDict() {
    if (dictDetailKey) {
      renderDictDetail();
      return;
    }
    $("dict-detail").hidden = true;
    $("dict-card").hidden = !view.payload;
    if (view.payload) drawDictResults();
  }
  function renderStart() {
    $("start-card").hidden = !view.payload;
  }
  function showHome(show) {
    $("home").hidden = !show;
    $("session-card").hidden = show;
  }
  function showPane(name) {
    document.querySelectorAll("#tabs .tab").forEach((btn) => {
      btn.classList.toggle("on", btn.dataset.tab === name);
    });
    document.querySelectorAll(".pane").forEach((pane) => {
      pane.hidden = pane.id !== "pane-".concat(name);
    });
  }
  function startSession(size, words) {
    if (!view.payload) return;
    const host = $("session-card");
    showHome(false);
    openSession({
      db,
      words: words || view.payload.words,
      baseUrl: view.payload.baseUrl,
      states: view.progress,
      extMap: view.ext ? view.ext.map : null,
      size,
      host,
      onExit: async () => {
        await refresh();
        showHome(true);
      }
    });
  }
  async function refresh() {
    const { packs, removed } = await restorePacks(db);
    if (removed.length) console.warn("\u5DF2\u6E05\u7406\u635F\u574F\u7684\u8BCD\u5305\uFF1A", removed);
    view.packs = packs;
    view.activeId = await getActivePackId(db);
    const active = packs.find((p) => p.record.id === view.activeId) || packs[0] || null;
    view.payload = active ? active.payload : null;
    view.progress = await loadProgress(db);
    renderStart();
    renderPacks();
    renderStats();
    renderDict();
    await renderLists();
    setStatus(
      packs.length ? "\u5C31\u7EEA \xB7 ".concat(packs.length, " \u4E2A\u8BCD\u5305") : "\u6CA1\u6709\u53EF\u7528\u8BCD\u5305\uFF0C\u53BB\u8BBE\u7F6E\u533A\u4E0B\u8F7D",
      packs.length === 0
    );
    await renderAudio();
  }
  async function boot() {
    try {
      if (!IS_LEGACY && "serviceWorker" in navigator) {
        navigator.serviceWorker.register("./sw.js").catch((err) => console.warn("Service Worker \u6CE8\u518C\u5931\u8D25", err));
      }
      setStatus("\u6B63\u5728\u6253\u5F00\u672C\u5730\u6570\u636E\u5E93\u2026");
      const extPromise = loadExt();
      db = await openStore();
      setStatus("\u6B63\u5728\u6062\u590D\u5DF2\u4E0B\u8F7D\u7684\u8BCD\u5305\u2026");
      const existing = await restorePacks(db);
      if (!existing.packs.length) {
        setStatus("\u672C\u5730\u6CA1\u6709\u8BCD\u5305\uFF0C\u6B63\u5728\u4E0B\u8F7D\u5185\u7F6E\u8BCD\u5305\u2026");
        await downloadPack(db, { baseUrl: BUNDLED_BASE });
      }
      view.ext = await extPromise;
      await refresh();
    } catch (err) {
      showError("\u521D\u59CB\u5316\u5931\u8D25\uFF1A", err);
      setStatus("\u521D\u59CB\u5316\u5931\u8D25\uFF1A".concat(err.message), true);
    }
  }
  $("btn-download").onclick = async () => {
    const btn = $("btn-download");
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "\u4E0B\u8F7D\u4E2D\u2026";
    try {
      await downloadPack(db, { baseUrl: BUNDLED_BASE });
      await refresh();
      btn.textContent = "\u5DF2\u4E0B\u8F7D";
      setTimeout(() => {
        btn.textContent = label;
      }, 1500);
    } catch (err) {
      btn.textContent = label;
      showError("\u4E0B\u8F7D\u5931\u8D25\uFF1A", err);
      setStatus("\u8BCD\u5305\u4E0B\u8F7D\u5931\u8D25\uFF1A".concat(err.message), true);
    } finally {
      btn.disabled = false;
    }
  };
  $("btn-audio").onclick = async () => {
    const btn = $("btn-audio");
    if (!audioNames.length) return;
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = "\u4E0B\u8F7D\u4E2D\u2026";
    try {
      const state = await downloadAudio(audioNames, {
        concurrency: 6,
        onProgress: (s) => {
          btn.textContent = "\u4E0B\u8F7D\u4E2D\u2026 ".concat(s.done, "/").concat(s.total);
          $("audio-fill").style.width = "".concat(s.done / s.total * 100, "%");
          $("audio-hint").textContent = "\u5DF2\u4E0B\u8F7D ".concat(s.skipped + s.ok, " / ").concat(s.total).concat(s.failed.length ? "\uFF08\u5931\u8D25 ".concat(s.failed.length, "\uFF09") : "");
        }
      });
      const have = await countCached(audioNames);
      $("audio-hint").textContent = state.failed.length ? "\u5DF2\u4E0B\u8F7D ".concat(have, " / ").concat(state.total, "\uFF0C\u5931\u8D25 ").concat(state.failed.length, " \u4E2A \u2014\u2014 \u518D\u70B9\u4E00\u6B21\u4F1A\u8DF3\u8FC7\u5DF2\u4E0B\u8F7D\u7684") : "\u5168\u90E8\u5C31\u7EEA\uFF1A".concat(have, " / ").concat(state.total, " \u4E2A\u53D1\u97F3\u5DF2\u53EF\u79BB\u7EBF\u64AD\u653E");
      btn.textContent = state.failed.length ? "\u6709\u5931\u8D25\uFF0C\u91CD\u8BD5" : "\u5DF2\u5C31\u7EEA";
      setStatus(state.failed.length ? "\u53D1\u97F3\u4E0B\u8F7D\u672A\u5B8C\u6210\uFF1A\u5931\u8D25 ".concat(state.failed.length, " \u4E2A") : "\u53D1\u97F3\u5DF2\u4E0B\u8F7D ".concat(have, " \u4E2A \xB7 ").concat(fmtBytes(state.bytes)));
    } catch (err) {
      btn.textContent = label;
      showError("\u53D1\u97F3\u4E0B\u8F7D\u5931\u8D25\uFF1A", err);
      setStatus("\u53D1\u97F3\u4E0B\u8F7D\u5931\u8D25\uFF1A".concat(err.message), true);
    } finally {
      btn.disabled = false;
      setTimeout(() => {
        if (btn.textContent !== label) btn.textContent = "\u4E0B\u8F7D\u5168\u90E8\u53D1\u97F3";
      }, 4e3);
    }
  };
  $("tabs").addEventListener("click", (e) => {
    const btn = e.target.closest(".tab");
    if (btn) showPane(btn.dataset.tab);
  });
  $("dict-q").addEventListener("input", drawDictResults);
  $("btn-start").onclick = () => {
    const sel = $("size");
    const size = Number(sel.value) || Number(sel.options[0] && sel.options[0].value) || 0;
    if (size > 0) startSession(size);
  };
  boot();
})();
