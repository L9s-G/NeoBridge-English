/**
 * Shared EVP record -> row mapping and SQLite writer.
 *
 * Used by scrape-evp.mjs (live harvest) and rebuild-db.mjs (rebuild from
 * data/raw/checkpoint.json without touching the network).
 *
 * Terminology
 * -----------
 *   refid        Entry id as it appears in the source (e.g. ID_00000045).
 *                One refid == one dictionary entry == one headword (hw_text).
 *                A few source rows carry a sense-level id instead
 *                (e.g. ID_00003010_520_UK); those still resolve on the site
 *                but point at a single sense rather than the whole entry.
 *   entry_refid  refid normalised to entry level, so every row joins cleanly
 *                onto evp_entry.
 *   headword     hw_text -- the surface form the entry is filed under.
 *                A headword may span several entries (tear/row/lie are true
 *                homonyms), and one base_word may sit under several
 *                headwords (a phrase is cross-listed under each word it
 *                contains: "all over again" -> again / all / over).
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, rmSync } from 'node:fs';

export const DATA_TYPE = 'custom.evp_uk1';
export const LEVELS = ['B1', 'B2'];
export const DETAIL_BASE = 'https://englishprofile.org/?menu=evp-online&refid=';
export const EXPECTED_TOTAL = 7101;

const WORD_COLUMNS = [
  'id', 'bubble_id', 'base_word', 'guideword', 'level', 'pos', 'topic', 'headword',
  'refid', 'entry_refid', 'details_url', 'entry_url', 'definition', 'pronunciation',
  'examples', 'audio_name',
];

/**
 * 发音文件名的规范形式：全小写。
 * 源库里同一音频既有 `UKCLD00440` 又有 `ukcld00440`，而 Windows/多数静态托管
 * 对文件名大小写不敏感，统一小写可保证包里的 `a` 和磁盘上的文件严格对得上。
 */
export function canonicalAudioName(name) {
  return name ? String(name).trim().toLowerCase() : null;
}

export function normalizeEntryRefid(refid) {
  return refid ? refid.replace(/_\d+_UK$/, '') : null;
}

export function topicOf(record, topicLookup) {
  const direct = (record.l_topic_text_text || '').trim();
  if (direct) return direct;
  const list = record.l_topics_list_custom_evp_l_topic;
  if (Array.isArray(list) && list.length) {
    const names = list
      .map(id => topicLookup.get(String(id).split('__LOOKUP__').pop()))
      .filter(Boolean);
    if (names.length) return names.join(', ');
  }
  return null;
}

export function buildRows(records, topicLookup) {
  const rows = [];
  const offFilter = [];
  for (const r of records.values()) {
    if (r._type !== DATA_TYPE) continue;
    if (!LEVELS.includes(r.cefr_text_text)) {
      offFilter.push(r);
      continue;
    }
    const refid = r.refid_text || null;
    const headword = r.hw_text ? r.hw_text.trim() : null;
    rows.push({
      bubble_id: r._id,
      base_word: (r.base_text || '').trim(),
      guideword: r.guideword_text ? r.guideword_text.trim() : null,
      level: r.cefr_text_text,
      pos: r.pos_text ? r.pos_text.trim() : null,
      topic: topicOf(r, topicLookup),
      headword,
      refid,
      entry_refid: normalizeEntryRefid(refid),
      details_url: refid ? `${DETAIL_BASE}${refid}` : null,
      entry_url: normalizeEntryRefid(refid) ? `${DETAIL_BASE}${normalizeEntryRefid(refid)}` : null,
      definition: r.definition_text || null,
      pronunciation: (r.ukpron_text || '').trim() || null,
      examples: r.learnerexamples_text || null,
      audio_name: canonicalAudioName(r.audiofilename_text),
    });
  }
  return { rows, offFilter };
}

export function sortRows(rows) {
  rows.sort((a, b) => a.base_word.localeCompare(b.base_word, 'en')
    || (a.guideword || '').localeCompare(b.guideword || '')
    || a.level.localeCompare(b.level));
  return rows;
}

function buildEntries(rows) {
  const map = new Map();
  for (const r of rows) {
    const key = r.entry_refid;
    let e = map.get(key);
    if (!e) {
      e = { refid: key, headword: r.headword, levels: new Set(), words: new Set(), senses: 0 };
      map.set(key, e);
    }
    if (e.headword !== r.headword) {
      throw new Error(`entry ${key} mixes headwords "${e.headword}" and "${r.headword}"`);
    }
    e.levels.add(r.level);
    e.words.add(r.base_word);
    e.senses += 1;
  }
  return [...map.values()]
    .map(e => ({
      refid: e.refid,
      headword: e.headword,
      member_count: e.words.size,
      sense_count: e.senses,
      levels: [...e.levels].sort().join(','),
      member_words: [...e.words].sort((a, b) => a.localeCompare(b, 'en')).join('\n'),
    }))
    .sort((a, b) => a.refid.localeCompare(b.refid));
}

/**
 * 读 data/raw/audio-files.json（`npm run scrape:audio` 产出）。
 * 返回 Map<规范名, url>。文件不存在时返回空 Map —— 没有音频也能建库。
 */
export function loadAudioMap(path) {
  if (!existsSync(path)) return new Map();
  const payload = JSON.parse(readFileSync(path, 'utf8'));
  const map = new Map();
  for (const [name, url] of Object.entries(payload.files || {})) {
    map.set(canonicalAudioName(name), url);
  }
  return map;
}

/**
 * 官网声称有音频、但音频表里查不到 URL 的名字（5 个名 / 7 行，官网自己也播不了）
 * 一律按 null 存。约定：evp_word.audio_name 非空 ⇔ evp_audio 里有 URL ⇔ 有本地 mp3，
 * 下游（词包的 a、卡片喇叭）据此判断有没有发音，缺的回落 YouGlish。
 * 原始文件名仍留在 data/raw/checkpoint.json 的 audiofilename_text 里，源数据不动。
 * 音频表整体缺失时（没跑过 scrape:audio）保留原值，避免把 5462 行全抹掉。
 */
function resolvableAudioName(name, audio) {
  if (!name) return null;
  if (!audio.size) return name;
  return audio.has(name) ? name : null;
}

/**
 * options.audio: Map<规范名, url>，写进 evp_audio 表（发音文件的来源 URL）。
 */
export function writeDb(rows, dbPath, options = {}) {
  const { audio = new Map() } = options;
  if (existsSync(dbPath)) rmSync(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE evp_word (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      bubble_id     TEXT    NOT NULL UNIQUE,
      base_word     TEXT    NOT NULL,
      guideword     TEXT,
      level         TEXT    NOT NULL,
      pos           TEXT,
      topic         TEXT,
      headword      TEXT,
      refid         TEXT,
      entry_refid   TEXT,
      details_url   TEXT,
      entry_url     TEXT,
      definition    TEXT,
      pronunciation TEXT,
      examples      TEXT,
      audio_name    TEXT
    );
    CREATE INDEX ix_level      ON evp_word(level);
    CREATE INDEX ix_base_word  ON evp_word(base_word);
    CREATE INDEX ix_headword   ON evp_word(headword);
    CREATE INDEX ix_refid      ON evp_word(refid);
    CREATE INDEX ix_entry_refid ON evp_word(entry_refid);
    CREATE INDEX ix_pos        ON evp_word(pos);
    CREATE INDEX ix_audio_name ON evp_word(audio_name);

    CREATE TABLE evp_entry (
      refid        TEXT PRIMARY KEY,
      headword     TEXT    NOT NULL,
      member_count INTEGER NOT NULL,
      sense_count  INTEGER NOT NULL,
      levels       TEXT    NOT NULL,
      member_words TEXT    NOT NULL
    );
    CREATE INDEX ix_entry_headword ON evp_entry(headword);

    CREATE TABLE evp_audio (
      name TEXT PRIMARY KEY,
      url  TEXT NOT NULL
    );
  `);

  const insertWord = db.prepare(`
    INSERT INTO evp_word
      (bubble_id, base_word, guideword, level, pos, topic, headword, refid, entry_refid,
       details_url, entry_url, definition, pronunciation, examples, audio_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertEntry = db.prepare(`
    INSERT INTO evp_entry (refid, headword, member_count, sense_count, levels, member_words)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertAudio = db.prepare('INSERT INTO evp_audio (name, url) VALUES (?, ?)');

  const entries = buildEntries(rows);
  db.exec('BEGIN');
  for (const r of rows) {
    insertWord.run(
      r.bubble_id, r.base_word, r.guideword, r.level, r.pos, r.topic, r.headword,
      r.refid, r.entry_refid, r.details_url, r.entry_url,
      r.definition, r.pronunciation, r.examples, resolvableAudioName(r.audio_name, audio),
    );
  }
  for (const e of entries) {
    insertEntry.run(e.refid, e.headword, e.member_count, e.sense_count, e.levels, e.member_words);
  }
  for (const [name, url] of audio) {
    insertAudio.run(name, url);
  }
  db.exec('COMMIT');
  db.close();
  return entries;
}

export function report(rows, offFilter, audio = new Map()) {
  const byLevel = {};
  for (const r of rows) byLevel[r.level] = (byLevel[r.level] || 0) + 1;
  // 与 writeDb 同一套口径：查不到 URL 的名字不计入 audio_name
  const audioNames = rows.map(r => resolvableAudioName(r.audio_name, audio));
  const nonEmpty = k => (k === 'audio_name'
    ? audioNames.filter(Boolean).length
    : rows.filter(r => r[k]).length);
  const keys = ['guideword', 'pos', 'topic', 'headword', 'details_url', 'definition', 'pronunciation', 'examples', 'audio_name'];

  console.log('\n================ REPORT ================');
  console.log(`rows written        : ${rows.length}  (expected ${EXPECTED_TOTAL})`);
  console.log(`off-filter records  : ${offFilter.length}`);
  console.log(`levels              : ${JSON.stringify(byLevel)}`);
  console.log(`distinct base_word  : ${new Set(rows.map(r => r.base_word)).size}`);
  console.log(`distinct headword   : ${new Set(rows.map(r => r.headword)).size}`);
  console.log(`distinct refid      : ${new Set(rows.map(r => r.refid)).size}`);
  console.log(`distinct entry_refid: ${new Set(rows.map(r => r.entry_refid)).size}`);
  console.log(`distinct audio_name : ${new Set(audioNames.filter(Boolean)).size}`);
  for (const k of keys) {
    const n = nonEmpty(k);
    console.log(`${(k + ' filled').padEnd(20)}: ${n} / ${rows.length} (${((n / rows.length) * 100).toFixed(1)}%)`);
  }
  console.log('sample rows:');
  for (const r of rows.slice(0, 3)) console.log('  ' + JSON.stringify(r));
  console.log('========================================\n');
  return rows.length === EXPECTED_TOTAL;
}
