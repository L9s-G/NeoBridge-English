import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

import { validateWordExt } from '../app/js/llm/validate.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = p => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

const ext = read('app/data/ext.v1.json');
const manifest = read('app/data/manifest-ext.json');
const pack = read('app/data/words.v2.json');
const source = read('data/raw/word-ext.json');

test('manifest-ext 与正文一致（bytes / sha256 / count）', () => {
  const body = readFileSync(join(ROOT, 'app/data/ext.v1.json'), 'utf8');
  assert.equal(manifest.bytes, Buffer.byteLength(body));
  assert.equal(manifest.sha256, createHash('sha256').update(body).digest('hex'));
  assert.equal(manifest.count, ext.count);
  assert.equal(manifest.extVersion, ext.extVersion);
});

test('键集 = 词包单单词（不缺不多）', () => {
  const singles = pack.words.filter(w => !/\s/.test(w.k)).map(w => w.k).sort();
  const keys = Object.keys(ext.words).sort();
  assert.deepEqual(keys, singles);
  assert.equal(ext.count, singles.length);
});

test('首发策略：etymology 整块留空，产物全量过 validateWordExt', () => {
  assert.equal(ext.etymologyStripped, true);
  let checked = 0;
  for (const [k, e] of Object.entries(ext.words)) {
    assert.equal(e.etymology.origin, '', `${k} origin 未留空`);
    assert.equal(e.etymology.story, '', `${k} story 未留空`);
    assert.deepEqual(e.etymology.path, [], `${k} path 未留空`);
    const r = validateWordExt(e, k);
    assert.equal(r.ok, true, `${k}: ${r.errors.join('；')}`);
    checked += 1;
  }
  assert.equal(checked, ext.count);
});

test('源数据（word-ext.json）全量过 validateWordExt —— 构建门禁与测试同源', () => {
  const failures = [];
  for (const src of source.words) {
    const r = validateWordExt(
      { zh: src.zh, family: src.family, etymology: src.etymology },
      src.k,
    );
    if (!r.ok) failures.push(`${src.k}: ${r.errors.join('；')}`);
  }
  assert.deepEqual(failures, []);
  assert.equal(source.words.length, ext.count);
});
