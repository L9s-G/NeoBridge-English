/**
 * 词包导入的纯逻辑校验 —— 不碰 IndexedDB，直接跑真实的 app/data/。
 * 下载流程（fetch + 落库）在浏览器里验，这里只验"该不该收下这份数据"。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { buildPackRecord, decodePack, sha256Hex, validatePack } from '../app/js/db/importer.js';
import { packIdOf } from '../app/js/db/stores.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA = join(ROOT, 'app', 'data');
const manifest = JSON.parse(readFileSync(join(DATA, 'manifest.json'), 'utf8'));
const fileBytes = new Uint8Array(readFileSync(join(DATA, manifest.file)));

test('sha256Hex 与已知向量一致', async () => {
  assert.equal(
    await sha256Hex(new Uint8Array(0)),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
  assert.equal(
    await sha256Hex(new TextEncoder().encode('abc')),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});

test('真实词包通过全部下载校验', async () => {
  const record = await buildPackRecord(fileBytes, manifest, 42);

  assert.equal(record.id, packIdOf(manifest));
  assert.equal(record.sha256, manifest.sha256);
  assert.equal(record.bytes, manifest.bytes);
  assert.equal(record.wordCount, manifest.wordCount);
  assert.equal(record.senseCount, manifest.senseCount);
  assert.equal(record.baseUrl, 'https://englishprofile.org/?menu=evp-online&refid=');
  assert.equal(record.importedAt, 42);

  const payload = decodePack(record);
  assert.equal(payload.words.length, record.wordCount);
  assert.equal(validatePack(payload), true);
});

test('字节数对不上时拒绝', async () => {
  const short = fileBytes.subarray(0, 100);
  await assert.rejects(() => buildPackRecord(short, manifest, 1), /字节数/);
});

test('字节被篡改时 sha256 拦下（长度不变）', async () => {
  const tampered = new Uint8Array(fileBytes);
  tampered[100] ^= 0xff;
  await assert.rejects(() => buildPackRecord(tampered, manifest, 1), /sha256/);
});

test('manifest 与包头交叉核对', async () => {
  await assert.rejects(
    () => buildPackRecord(fileBytes, { ...manifest, packId: 'other' }, 1),
    /packId/,
  );
  await assert.rejects(
    () => buildPackRecord(fileBytes, { ...manifest, wordCount: manifest.wordCount + 1 }, 1),
    /wordCount/,
  );
});

test('validatePack 抓出包内不自洽', () => {
  const payload = JSON.parse(new TextDecoder().decode(fileBytes));
  const mutate = patch => ({ ...payload, ...patch });

  assert.throws(() => validatePack(mutate({ schemaVersion: 99 })), /schemaVersion/);
  assert.throws(() => validatePack(mutate({ baseUrl: '' })), /baseUrl/);
  assert.throws(() => validatePack(mutate({ words: null })), /words/);
  assert.throws(() => validatePack(mutate({ wordCount: 1 })), /wordCount/);
  assert.throws(() => validatePack(mutate({ senseCount: 1 })), /senseCount/);

  const noKey = payload.words.map((w, i) => (i === 0 ? { ...w, k: '' } : w));
  assert.throws(() => validatePack(mutate({ words: noKey })), /wordKey/);
});

test('packIdOf 用 packId@version', () => {
  assert.equal(packIdOf({ packId: 'evp-uk-b1b2', version: 1 }), 'evp-uk-b1b2@1');
  assert.notEqual(packIdOf({ packId: 'evp-uk-b1b2', version: 2 }), 'evp-uk-b1b2@1');
});
