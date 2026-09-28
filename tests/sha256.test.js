/**
 * 纯 JS SHA-256（core/sha256.js）的单测 —— 它是 crypto.subtle 不可用时
 * （http 局域网）词包校验的唯一保障，必须与 crypto.subtle 完全对拍。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sha256Bytes } from '../app/js/core/sha256.js';
import { mulberry32 } from './_rng.js';

const hex = bytes => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');

async function subtleHex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return hex(new Uint8Array(digest));
}

test('NIST 向量：空串与 "abc"', () => {
  assert.equal(hex(sha256Bytes(new Uint8Array(0))),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(hex(sha256Bytes(new TextEncoder().encode('abc'))),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('padding 边界长度与 crypto.subtle 对拍', async () => {
  // len + 0x80 + 8 字节位长 → 单块上限 55 字节；56/57 进第二块；119/120 进第三块
  const lengths = [1, 2, 27, 54, 55, 56, 57, 63, 64, 65, 119, 120, 121, 127, 128, 129, 1000];
  for (const len of lengths) {
    const data = new Uint8Array(len);
    const rng = mulberry32(len);
    for (let i = 0; i < len; i++) data[i] = (rng() * 256) | 0;
    assert.equal(hex(sha256Bytes(data)), await subtleHex(data), `长度 ${len} 不一致`);
  }
});

test('与 crypto.subtle 对拍（固定种子随机 ×20 组）', async () => {
  const rng = mulberry32(20260928);
  for (let round = 0; round < 20; round++) {
    const len = (rng() * 5000) | 0;
    const data = new Uint8Array(len);
    for (let i = 0; i < len; i++) data[i] = (rng() * 256) | 0;
    assert.equal(hex(sha256Bytes(data)), await subtleHex(data), `第 ${round} 轮（${len} 字节）不一致`);
  }
});

test('位长字段：超过 2^29 字节的高 32 位公式（纯算式验证）', () => {
  // sha256Bytes 内部：高 32 位 = floor(len / 2^29)，低 32 位 = (len << 3) >>> 0
  for (const len of [0, 1, 67108863, 67108864, 536870912, 536870913]) {
    assert.equal(Math.floor(len / 0x20000000), len >>> 29, String(len));
    assert.equal((len << 3) >>> 0, (len * 8) % 4294967296, String(len));
  }
});
