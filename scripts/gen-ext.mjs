#!/usr/bin/env node
/**
 * 词级扩展信息（中文详解 / 家族词 / 词源）试点批量生成。
 *
 *   node scripts/gen-ext.mjs                 # 内置 20 个试点词 → word-ext.pilot.json
 *   node scripts/gen-ext.mjs --all           # 全部单单词（3645，短语除外）→ word-ext.json
 *   node scripts/gen-ext.mjs --words a,b,c   # 只跑这些词（补齐进产物，已有且成功的跳过）
 *   LLM_BASE_URL=http://127.0.0.1:15721/v1 node scripts/gen-ext.mjs
 *
 * 路径：词包读 grounding → buildWordExtPrompt → 限速队列 → chat(json)
 *      → parseWordExt → validateWordExt（失败重试 1 次）→ 落盘
 *
 * prompt / 解析 / 校验全部 import app/js/llm/ —— 与浏览器测试页
 * llm-test.html 走同一套代码，这就是本轮要验证的"路径可靠性"。
 *
 * 产物文件本身就是断点：每词落盘一次，重跑时同 promptV 且成功的条目直接跳过，
 * 失败的自动补跑——全量批跑（~14 小时）中断不用归零，也不需要单独的 checkpoint。
 * 换了 PROMPT_VERSION 的旧条目视为过期，全部重新生成（不留历史）。
 *
 * 输出：data/raw/word-ext.pilot.json（试点）/ data/raw/word-ext.json（全量），不进 app/data/。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chat, LlmError } from '../app/js/llm/client.js';
import { buildWordExtPrompt, parseWordExt, PROMPT_VERSION } from '../app/js/llm/prompts.js';
import { createQueue } from '../app/js/llm/ratelimit.js';
import { validateWordExt } from '../app/js/llm/validate.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PACK_PATH = join(ROOT, 'app', 'data', 'words.v2.json');
const RAW_DIR = join(ROOT, 'data', 'raw');
const OUTPUT_PILOT = join(RAW_DIR, 'word-ext.pilot.json');
const OUTPUT_ALL = join(RAW_DIR, 'word-ext.json');

/** 试点词单：多义 / 同形异义 / 长短混合 / 带短语家族（词必须在 B1/B2 词包里） */
const PILOT_WORDS = [
  'account', 'tear', 'row', 'lie', 'run', 'set', 'light', 'bear',
  'novel', 'state', 'mean', 'fine', 'subject', 'train', 'watch', 'grant', 'promise', 'charge',
  'turn', 'record',
];

const CFG = {
  baseUrl: process.env.LLM_BASE_URL || 'http://127.0.0.1:15721/v1',
  model: process.env.LLM_MODEL || 'agnes-3.0-flash',
  apiKey: process.env.LLM_API_KEY || 'PROXY_MANAGED',
};

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

/* ---------------- 单词生成（含 1 次重试） ---------------- */

async function generateOne(word, phrases, push) {
  const messages = buildWordExtPrompt(word, phrases);
  let lastErr = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const content = await push(() => chat(messages, CFG, { json: true, timeoutMs: 90000 }));
      const parsed = parseWordExt(content);
      const result = validateWordExt(parsed, word.k);
      if (result.ok) {
        return { ok: true, attempts: attempt, ...result.cleaned, dropped: result.dropped };
      }
      lastErr = new Error(`校验失败：${result.errors.join('；')}`);
      if (result.dropped.length) {
        console.log(`  第 ${attempt} 次：${result.dropped.length} 个家族词被剔除（不判死刑）`);
      }
    } catch (err) {
      lastErr = err;
      const code = err instanceof LlmError ? `[${err.code}] ` : '';
      console.log(`  第 ${attempt} 次失败：${code}${err.message}`);
      // 网络类错误重试也没意义（服务没开），直接中断
      if (err instanceof LlmError && err.code === 'NETWORK') throw err;
    }
    if (attempt === 1) console.log('  重试 1 次…');
  }

  return { ok: false, error: lastErr ? lastErr.message : '未知错误' };
}

/* ---------------- main ---------------- */

/** 产物即断点：只认同 promptV 且成功的条目（失败的补跑，换版本的重跑） */
function loadPrior(file) {
  if (!existsSync(file)) return {};
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    if (data.promptV !== PROMPT_VERSION) {
      console.log(`  产物是 promptV ${data.promptV}（当前 ${PROMPT_VERSION}），全部重新生成`);
      return {};
    }
    const prior = {};
    for (const w of data.words || []) if (w && !w.error) prior[w.k] = w;
    return prior;
  } catch {
    console.warn('  产物解析失败，全部重新生成');
    return {};
  }
}

async function main() {
  console.log(`[1/3] 读词包 ${PACK_PATH}`);
  const { byKey, phrasesOf } = loadPack();

  const allMode = process.argv.includes('--all');
  const argIdx = process.argv.indexOf('--words');
  let keys;
  if (allMode) {
    keys = [...byKey.keys()].filter(k => !/\s/.test(k)); // 短语不扩展（词源/家族词对短语无意义）
  } else if (argIdx >= 0 && process.argv[argIdx + 1]) {
    keys = process.argv[argIdx + 1].split(',').map(s => s.trim()).filter(Boolean);
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

  const outputFile = allMode ? OUTPUT_ALL : OUTPUT_PILOT;
  const prior = loadPrior(outputFile);
  const pending = targets.filter(w => !prior[w.k]);
  console.log(`[2/3] 共 ${targets.length} 词，产物已有 ${targets.length - pending.length}，待生成 ${pending.length}（promptV ${PROMPT_VERSION}）`);
  if (!pending.length) {
    console.log('[3/3] 全部已完成');
    writeOutput(prior, {}, targets, outputFile);
    return;
  }

  // RPM 10 → 默认 6.5s 间隔；环境变量可调快（比如上游放开限速时）
  const push = createQueue({ minIntervalMs: Number(process.env.LLM_MIN_INTERVAL || 6500) });

  const results = {};
  let failed = 0;
  const t0Run = Date.now();
  for (let i = 0; i < pending.length; i += 1) {
    const word = pending[i];
    const t0 = Date.now();
    console.log(`[${targets.length - pending.length + i + 1}/${targets.length}] ${word.w} …`);
    try {
      const result = await generateOne(word, phrasesOf(word.k), push);
      results[word.k] = {
        k: word.k,
        w: word.w,
        promptV: PROMPT_VERSION,
        model: CFG.model,
        generatedAt: new Date().toISOString(),
        ...result,
      };
      if (result.ok) {
        const story = result.etymology.story ? `${result.etymology.story.length} 字` : '空';
        console.log(`  ✓ zh ${result.zh.length} 字，family ${result.family.length}，story ${story}（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
      } else {
        failed += 1;
        console.log(`  ✗ ${result.error}`);
      }
    } catch (err) {
      console.error(`  ✗ 中断：${err.message}`);
      console.error('  进度已写入产物文件，重跑同一命令自动续上');
      process.exit(2);
    }
    // 每词落盘：14 小时的批跑随时可断
    writeOutput(prior, results, targets, outputFile, { quiet: true });
    if ((i + 1) % 20 === 0) {
      const elapsed = Date.now() - t0Run;
      const perWord = elapsed / (i + 1);
      const remainMin = Math.round((pending.length - i - 1) * perWord / 60000);
      const usedMin = Math.round(elapsed / 60000);
      console.log(`  ── 进度 ${targets.length - pending.length + i + 1}/${targets.length} · 本轮已用 ${usedMin} 分钟 · 预计还需 ${remainMin} 分钟 ──`);
    }
  }

  console.log(`[3/3] 本轮成功 ${pending.length - failed}，失败 ${failed}；产物可用 ${targets.length - failed}/${targets.length}`);
  writeOutput(prior, results, targets, outputFile);
  if (failed) process.exitCode = 3;
}

function writeOutput(prior, results, targets, file, { quiet = false } = {}) {
  const words = targets
    .map(w => results[w.k] || prior[w.k])
    .filter(Boolean)
    .map(({ ok, attempts, dropped, ...entry }) => entry); // 失败的留 error，成功的不带内部字段

  const payload = {
    kind: 'word-ext',
    promptV: PROMPT_VERSION,
    model: CFG.model,
    generatedAt: new Date().toISOString(),
    count: words.length,
    words,
  };
  mkdirSync(RAW_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify(payload, null, 1));
  if (!quiet) console.log(`  → ${file}（${words.filter(w => !w.error).length}/${words.length} 可用）`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
