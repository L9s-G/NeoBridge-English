#!/usr/bin/env node
/**
 * 扩展数据发布构建：data/raw/word-ext.json → app/data/ext.v1.json + manifest-ext.json
 *
 *   npm run build:ext
 *
 * 首发策略（STRIP_ETYMOLOGY，全量核查后的决定）：
 *   词源块（origin 词源解释 + path 演变链）与故事块（story）**整块留空不发布** ——
 *   audit-ext 抽样显示这两块是编造重灾区（虚构词根、演变链断层），等有可靠的
 *   生成与核查办法再恢复。源数据 word-ext.json 原样保留（审计、修复还要用全量），
 *   只在发布层剥离；UI 读到空字段整块不渲染，短语卡与无 etymology 的卡同路径。
 *   将来恢复：STRIP_ETYMOLOGY 改 false → rebuild → push →
 *   客户端按 manifest sha 比对静默拉新（在线更新，见 ext-loader）。
 *
 * 门禁：每条过 validateWordExt（空 etymology 合法）才写盘；多出词包的孤儿键报错。
 * 产物入库（零构建部署）；manifest-ext.json 的 sha256/bytes 是客户端增量更新的比对依据。
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateWordExt } from '../app/js/llm/validate.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PACK_PATH = join(ROOT, 'app', 'data', 'words.v2.json');
const SOURCE_PATH = join(ROOT, 'data', 'raw', 'word-ext.json');
const OUT_DIR = join(ROOT, 'app', 'data');
const OUT_FILE = join(OUT_DIR, 'ext.v1.json');
const MANIFEST_FILE = join(OUT_DIR, 'manifest-ext.json');

const STRIP_ETYMOLOGY = true; // 首发策略，见文件头
const SCHEMA_VERSION = 1;
const EXT_VERSION = 1;

function validateEntry(src) {
  return validateWordExt(
    { zh: src.zh, family: src.family, etymology: src.etymology },
    src.k,
  );
}

function main() {
  const source = JSON.parse(readFileSync(SOURCE_PATH, 'utf8'));
  const pack = JSON.parse(readFileSync(PACK_PATH, 'utf8'));
  const singles = pack.words.filter(w => !/\s/.test(w.k)).map(w => w.k);
  const singleSet = new Set(singles);

  console.log(`[1/3] 源 ${source.words.length} 条 · 词包单单词 ${singles.length} 个`);

  // 门禁：逐条校验 + 键集对齐
  const bad = [];
  for (const src of source.words) {
    if (!singleSet.has(src.k)) {
      bad.push(`${src.k}: 词包里没有这个键（孤儿数据）`);
      continue;
    }
    const r = validateEntry(src);
    if (!r.ok) bad.push(`${src.k}: ${r.errors.join('；')}`);
  }
  if (bad.length) {
    console.error(`[2/3] 门禁未过 ${bad.length} 条：`);
    bad.slice(0, 20).forEach(b => console.error(`  ✗ ${b}`));
    process.exit(1);
  }
  const sourceK = new Set(source.words.map(w => w.k));
  const missing = singles.filter(k => !sourceK.has(k));
  if (missing.length) {
    console.warn(`  警告：词包有 ${missing.length} 个单单词没有扩展数据（卡背/字典会优雅跳过）：${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ' …' : ''}`);
  }

  // 组装
  const words = {};
  let strippedKept = 0;
  for (const src of source.words) {
    const etymology = STRIP_ETYMOLOGY
      ? { origin: '', path: [], story: '' }
      : {
          origin: src.etymology.origin,
          path: src.etymology.path,
          story: src.etymology.story,
        };
    if (STRIP_ETYMOLOGY && (src.etymology.origin || src.etymology.story || (src.etymology.path || []).length)) {
      strippedKept += 1;
    }
    words[src.k] = { zh: src.zh, family: src.family, etymology };
  }

  const payload = {
    schemaVersion: SCHEMA_VERSION,
    extVersion: EXT_VERSION,
    promptV: source.promptV,
    etymologyStripped: STRIP_ETYMOLOGY,
    count: Object.keys(words).length,
    words,
  };

  // 复检剥离后的产物仍全量合法（空 etymology 合法），再写盘
  for (const [k, e] of Object.entries(words)) {
    const r = validateWordExt(e, k);
    if (!r.ok) {
      console.error(`  ✗ 剥离后复检未过 ${k}: ${r.errors.join('；')}`);
      process.exit(1);
    }
  }

  const body = JSON.stringify(payload);
  const bytes = Buffer.byteLength(body);
  const sha256 = createHash('sha256').update(body).digest('hex');

  const manifest = {
    file: 'ext.v1.json',
    extVersion: EXT_VERSION,
    count: payload.count,
    bytes,
    sha256,
    etymologyStripped: STRIP_ETYMOLOGY,
    generatedAt: new Date().toISOString(),
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, body); // 紧凑 JSON，与 words.v2.json 同惯例
  writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2) + '\n');

  console.log(`[2/3] 门禁通过 ${source.words.length} 条（源含词源内容的 ${strippedKept} 条已剥离${STRIP_ETYMOLOGY ? '' : '（未剥离）'}）`);
  console.log(`[3/3] ${OUT_FILE}（${payload.count} 条 · ${(bytes / 1048576).toFixed(2)} MB · sha ${sha256.slice(0, 12)}）`);
  console.log(`      ${MANIFEST_FILE}`);
}

main();
