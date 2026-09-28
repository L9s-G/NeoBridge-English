#!/usr/bin/env node
/**
 * Quick inspection of data/evp.sqlite.
 *
 * Usage:
 *   node scripts/report-evp.mjs
 *   node scripts/report-evp.mjs --level B1
 *   node scripts/report-evp.mjs --search word
 *   node scripts/report-evp.mjs --entry ID_00000045   # one dictionary entry
 *   node scripts/report-evp.mjs --entry account       # ...by headword
 */

import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const db = new DatabaseSync(join(ROOT, 'data', 'evp.sqlite'));

const args = process.argv.slice(2);
const get = f => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : null;
};
const level = get('--level');
const search = get('--search');
const entry = get('--entry');

console.log('total :', db.prepare('SELECT COUNT(*) n FROM evp_word').get().n);
console.log('levels:', JSON.stringify(db.prepare('SELECT level, COUNT(*) n FROM evp_word GROUP BY level').all()));
console.log('entries:', JSON.stringify(db.prepare(
  'SELECT COUNT(*) total, SUM(member_count > 1) multi FROM evp_entry').get()));

if (entry) {
  const e = db.prepare('SELECT * FROM evp_entry WHERE refid = ? OR headword = ?').get(entry, entry);
  if (!e) {
    console.log(`\nno entry matching "${entry}"`);
  } else {
    console.log(`\n=== entry ${e.refid}  headword="${e.headword}"  levels=${e.levels}`);
    console.log(`    ${e.member_count} member word(s), ${e.sense_count} sense row(s)`);
    console.log(e.member_words.split('\n').map(w => `      - ${w}`).join('\n'));
    console.log(`    open: https://englishprofile.org/?menu=evp-online&refid=${e.refid}`);
    console.log('    rows:');
    for (const r of db.prepare(
      'SELECT base_word, guideword, level, pos, refid, definition FROM evp_word WHERE entry_refid = ? ORDER BY base_word, guideword'
    ).all(e.refid)) console.log('      ' + JSON.stringify(r));
  }
  db.close();
  process.exit(0);
}

const where = [];
const params = [];
if (level) { where.push('level = ?'); params.push(level); }
if (search) { where.push('(base_word LIKE ? OR guideword LIKE ? OR definition LIKE ?)'); params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
const sql = `SELECT * FROM evp_word${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY base_word LIMIT 20`;
for (const r of db.prepare(sql).all(...params)) console.log(r);
db.close();
