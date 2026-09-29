#!/usr/bin/env node
/**
 * 词级扩展信息（中文详解 / 家族词 / 词源）批量建库。
 *
 *   node scripts/gen-ext.mjs                    # 内置 20 个试点词 → word-ext.pilot.json
 *   node scripts/gen-ext.mjs --all              # 全部单单词（3645，短语除外）→ word-ext.json
 *   node scripts/gen-ext.mjs --words a,b,c      # 调试批 → word-ext.debug.json（不碰试点/全量）
 *   node scripts/gen-ext.mjs --words a --out data/raw/word-ext.json   # 补齐进指定产物
 *   node scripts/gen-ext.mjs --all --force      # 忽略已有条目，全部重新生成
 *   node scripts/gen-ext.mjs --all --no-verify  # 跳过背靠背核查
 *   LLM_BASE_URL=http://127.0.0.1:15721/v1 node scripts/gen-ext.mjs
 *
 * 词级管线（app/js/llm/pipeline.js，与测试页 llm-test.html 同一实现）：
 *   生成 → 本地校验 → family 局部问题定向修复 → 背靠背核查（独立端点，只给义项+数据）
 *   预算内修不好 → 不进正式产物，写 <产物名>.failed.json 交人工处理后入库。
 *
 * 留痕两份、与正式产物分离：
 *   word-ext.raw.jsonl        每轮模型原始输出 append-only（换清洗规则可重洗不花钱）
 *   <产物名>.failed.json      失败词的轮次轨迹/核查 issues/旧数据（previous），人工用
 *
 * 产物文件本身就是断点：同 promptV 且成功的条目直接跳过，失败/缺的自动补跑；
 * 写盘是"文件已有条目 ∪ 本次结果"合并（--words 子集不会裁掉文件里其他词）。
 * 换了 PROMPT_VERSION 的旧条目视为过期（--force 同理），旧数据挪进 failed 的 previous。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runWordPipeline } from '../app/js/llm/pipeline.js';
import { PROMPT_VERSION } from '../app/js/llm/prompts.js';
import { createQueue } from '../app/js/llm/ratelimit.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PACK_PATH = join(ROOT, 'app', 'data', 'words.v2.json');
const RAW_DIR = join(ROOT, 'data', 'raw');
const OUTPUT_PILOT = join(RAW_DIR, 'word-ext.pilot.json');
const OUTPUT_ALL = join(RAW_DIR, 'word-ext.json');
const OUTPUT_DEBUG = join(RAW_DIR, 'word-ext.debug.json');
const RAW_LOG = join(RAW_DIR, 'word-ext.raw.jsonl');

/** 试点词单：多义 / 同形异义 / 长短混合 / 带短语家族（词必须在 B1/B2 词包里） */
const PILOT_WORDS = [
  'account', 'tear', 'row', 'lie', 'run', 'set', 'light', 'bear',
  'novel', 'state', 'mean', 'fine', 'subject', 'train', 'watch', 'grant', 'promise', 'charge',
  'turn', 'record',
];

const genCfg = {
  baseUrl: process.env.LLM_BASE_URL || 'http://127.0.0.1:15721/v1',
  model: process.env.LLM_MODEL || 'agnes-3.0-flash',
  apiKey: process.env.LLM_API_KEY || 'PROXY_MANAGED',
};
// 核查端点：逐项回落生成端点 —— 换"另一个模型"时只改 LLM_VERIFY_MODEL 即可
const verifyCfg = {
  baseUrl: process.env.LLM_VERIFY_BASE_URL || genCfg.baseUrl,
  model: process.env.LLM_VERIFY_MODEL || genCfg.model,
  apiKey: process.env.LLM_VERIFY_API_KEY || genCfg.apiKey,
};

/* ---------------- CLI ---------------- */

const argv = process.argv.slice(2);
const flag = f => argv.includes(f);
const opt = f => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : null; };

const allMode = flag('--all');
const wordsArg = opt('--words');
const outArg = opt('--out');
const force = flag('--force');
const noVerify = flag('--no-verify');

/* ---------------- 词包 grounding ---------------- */

function loadPack() {
  const pack = JSON.parse(readFileSync(PACK_PATH, 'utf8'));
  const byKey = new Map(pack.words.map(w => [w.k, w]));

  // entry → 成员词：算出每个词的官方短语家族（零 LLM 成本的那部分）
  const entryMembers = new Map();
  for (const w of pack.words) {
    for (const e of w.entries || []) {
      if (!entryMembers.has(e)) entryMembers.set(e, []);
      entryMembers.get(e).push(w.k);
    }
  }

  const phrasesOf = k => {
    const word = byKey.get(k);
    const out = new Set();
    for (const e of (word && word.entries) || []) {
      for (const member of entryMembers.get(e) || []) if (member !== k) out.add(member);
    }
    return [...out].sort();
  };

  return { byKey, phrasesOf };
}

/* ---------------- 留痕：raw 每轮输出 / failed 人工清单 ---------------- */

function appendRaw(word, ev) {
  if (ev.type !== 'result') return;
  const line = JSON.stringify({
    k: word.k,
    stage: ev.stage,
    round: ev.round,
    at: new Date().toISOString(),
    costMs: ev.costMs,
    ...(ev.content !== undefined ? { content: ev.content } : { error: ev.error }),
  });
  try {
    mkdirSync(RAW_DIR, { recursive: true });
    appendFileSync(RAW_LOG, line + '\n');
  } catch (err) {
    console.warn(`  raw 留痕失败（不影响建库）：${err.message}`);
  }
}

const failedFileOf = outputFile => outputFile.replace(/\.json$/, '.failed.json');

function loadJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

function loadFileEntries(file) {
  const data = loadJson(file, null);
  return data && Array.isArray(data.words) ? data.words : [];
}

function writeFailed(file, entries) {
  const payload = {
    kind: 'word-ext-failed',
    promptV: PROMPT_VERSION,
    model: genCfg.model,
    generatedAt: new Date().toISOString(),
    count: entries.length,
    words: entries,
  };
  writeFileSync(file, JSON.stringify(payload, null, 1));
}

/* ---------------- 事件 → 控制台 ---------------- */

function logEvent(ev) {
  if (ev.type === 'result') {
    const sec = (ev.costMs / 1000).toFixed(1);
    if (ev.ok) console.log(`  [${ev.stage}#${ev.round}] ✓ ${sec}s`);
    else console.log(`  [${ev.stage}#${ev.round}] ✗ ${ev.error}`);
  } else if (ev.type === 'checked') {
    if (ev.stage === 'repair' && ev.ok) console.log('  修复 ✓ 复验通过');
    if (!ev.ok) {
      for (const f of ev.fatal) console.log(`  ✗ ${f}`);
      for (const d of ev.flagged) console.log(`  − ${d.w}：${d.why}`);
    }
  } else if (ev.type === 'verdict') {
    if (ev.pass) console.log('  核查 ✓');
    else console.log(`  核查 ✗ ${ev.issues.map(i => `${i.field}: ${i.problem}`).join('；')}`);
  }
}

/* ---------------- 正式产物：合并写盘 ---------------- */

function writeOutput(fileEntries, results, failedKeys, file, { quiet = false } = {}) {
  const map = new Map();
  for (const e of fileEntries) {
    if (e && e.k && !e.error && !failedKeys.has(e.k)) map.set(e.k, e); // 旧 error 条目与本轮失败的旧数据不进正式产物
  }
  for (const [k, e] of Object.entries(results)) if (e) map.set(k, e);
  for (const k of failedKeys) map.delete(k); // 本轮失败 → 只留 failed 清单交人工

  const words = [...map.values()];
  const payload = {
    kind: 'word-ext',
    promptV: PROMPT_VERSION,
    model: genCfg.model,
    generatedAt: new Date().toISOString(),
    count: words.length,
    words,
  };
  mkdirSync(RAW_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify(payload, null, 1));
  if (!quiet) console.log(`  → ${file}（${words.length} 条可用）`);
}

/* ---------------- main ---------------- */

async function main() {
  console.log(`[1/4] 读词包 ${PACK_PATH}`);
  const { byKey, phrasesOf } = loadPack();

  let keys;
  if (allMode) {
    keys = [...byKey.keys()].filter(k => !/\s/.test(k)); // 短语不扩展（词源/家族词对短语无意义）
  } else if (wordsArg) {
    keys = wordsArg.split(',').map(s => s.trim()).filter(Boolean);
  } else {
    keys = PILOT_WORDS;
  }

  const targets = [];
  for (const k of keys) {
    const word = byKey.get(k);
    if (!word) { console.warn(`  跳过：词包里没有 "${k}"`); continue; }
    targets.push(word);
  }
  if (!targets.length) { console.error('没有可生成的词'); process.exit(1); }

  const outputFile = outArg ? resolve(ROOT, outArg) : allMode ? OUTPUT_ALL : wordsArg ? OUTPUT_DEBUG : OUTPUT_PILOT;
  const failedFile = failedFileOf(outputFile);
  console.log(`  产物 ${outputFile}`);
  console.log(`  生成端点 ${genCfg.model} @ ${genCfg.baseUrl}`);
  if (!noVerify) console.log(`  核查端点 ${verifyCfg.model} @ ${verifyCfg.baseUrl}`);
  else console.log('  核查已跳过（--no-verify）');

  const fileEntries = loadFileEntries(outputFile);
  const oldByK = new Map(fileEntries.map(e => [e.k, e]));
  let prior = {};
  if (!force) {
    if (fileEntries.length && loadJson(outputFile, {}).promptV !== PROMPT_VERSION) {
      console.log(`  产物是 promptV ${loadJson(outputFile, {}).promptV}（当前 ${PROMPT_VERSION}），旧数据将挪进 failed 的 previous`);
    } else {
      for (const e of fileEntries) if (e && !e.error) prior[e.k] = e;
    }
  } else if (fileEntries.length) {
    console.log('  --force：忽略已有条目，旧数据将挪进 failed 的 previous');
  }

  const pending = targets.filter(w => !prior[w.k]);
  console.log(`[2/4] 共 ${targets.length} 词，产物已有 ${targets.length - pending.length}，待生成 ${pending.length}（promptV ${PROMPT_VERSION}）`);
  if (!pending.length) {
    console.log('[4/4] 全部已完成');
    writeOutput(fileEntries, {}, new Set(), outputFile);
    return;
  }

  let failedEntries = (loadJson(failedFile, { words: [] }).words || []).slice();
  const failedKeys = new Set(failedEntries.map(e => e.k).filter(k => !prior[k]));

  // RPM 10 → 默认 6.5s 间隔；环境变量可调快（比如上游放开限速时）
  const push = createQueue({ minIntervalMs: Number(process.env.LLM_MIN_INTERVAL || 6500) });

  const results = {};
  let failed = 0;
  const t0Run = Date.now();
  for (let i = 0; i < pending.length; i += 1) {
    const word = pending[i];
    const t0 = Date.now();
    console.log(`[${i + 1}/${pending.length}] ${word.w} …`);

    const onEvent = (ev) => { logEvent(ev); appendRaw(word, ev); };
    let res;
    try {
      res = await runWordPipeline(word, phrasesOf(word.k), {
        push, genCfg, verifyCfg, skipVerify: noVerify, onEvent,
      });
    } catch (err) {
      console.error(`  ✗ 中断：${err.message}`);
      console.error('  进度已写入产物文件，重跑同一命令自动续上');
      writeOutput(fileEntries, results, failedKeys, outputFile, { quiet: true });
      process.exit(2);
    }

    if (res.ok) {
      results[word.k] = {
        k: word.k,
        w: word.w,
        promptV: PROMPT_VERSION,
        model: genCfg.model,
        generatedAt: new Date().toISOString(),
        ...res.data,
      };
      failedKeys.delete(word.k);
      // 重跑成功 → 从人工清单摘掉并回写（否则 failed 文件留着已修好的旧记录）
      if (failedEntries.some(e => e.k === word.k)) {
        failedEntries = failedEntries.filter(e => e.k !== word.k);
        writeFailed(failedFile, failedEntries);
      }
      const story = res.data.etymology.story ? `${res.data.etymology.story.length} 字` : '空';
      console.log(`  ✓ zh ${res.data.zh.length} 字，family ${res.data.family.length}，story ${story} · ${res.stats.calls} 次调用 · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } else {
      failed += 1;
      failedKeys.add(word.k);
      const entry = {
        k: word.k,
        w: word.w,
        promptV: PROMPT_VERSION,
        model: genCfg.model,
        at: new Date().toISOString(),
        error: res.error,
        rounds: res.rounds,
        stats: res.stats,
        ...(res.verifyIssues ? { verifyIssues: res.verifyIssues } : {}),
        ...(oldByK.has(word.k) ? { previous: oldByK.get(word.k) } : {}),
      };
      failedEntries = [...failedEntries.filter(e => e.k !== word.k), entry];
      writeFailed(failedFile, failedEntries);
      console.log(`  ✗ 进人工清单：${failedFile}`);
    }

    // 每词落盘：长批跑随时可断
    writeOutput(fileEntries, results, failedKeys, outputFile, { quiet: true });
    if ((i + 1) % 20 === 0) {
      const elapsed = Date.now() - t0Run;
      const perWord = elapsed / (i + 1);
      const remainMin = Math.round((pending.length - i - 1) * perWord / 60000);
      const usedMin = Math.round(elapsed / 60000);
      console.log(`  ── 进度 ${i + 1}/${pending.length} · 本轮已用 ${usedMin} 分钟 · 预计还需 ${remainMin} 分钟 ──`);
    }
  }

  console.log(`[3/4] 本轮成功 ${pending.length - failed}，失败 ${failed}`);
  writeOutput(fileEntries, results, failedKeys, outputFile);
  if (failedEntries.length) console.log(`[4/4] 人工清单 ${failedFile}（${failedEntries.length} 条，处理后手工并回产物）`);
  if (failed) process.exitCode = 3;
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
