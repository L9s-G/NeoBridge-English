#!/usr/bin/env node
/**
 * 词级扩展数据全量核查（人工复查清单）—— 独立模块，专为"云端跑、结果拉回本地"设计。
 *
 *   node scripts/audit-ext.mjs                    # 全量核查（断点续跑）→ word-ext.audit.json
 *   node scripts/audit-ext.mjs --limit 20         # 先抽样试跑
 *   node scripts/audit-ext.mjs --words a,b,c      # 指定词
 *   node scripts/audit-ext.mjs --report           # 只打印已有结果的问题清单（不联网）
 *   node scripts/audit-ext.mjs --force            # 已有 verdict 也重跑
 *   LLM_VERIFY_MODEL=xxx node scripts/audit-ext.mjs   # 换核查模型（逐项回落生成端点）
 *
 * 与 gen-ext 的分工：
 *   gen-ext   生成 → 本地校验 → 修复，写 word-ext.json（数据本体）
 *   本脚本    背靠背核查（只给义项 + 数据，不给生成 prompt），写 word-ext.audit.json
 *             **只标记不删** —— 绝不改 word-ext.json；怎么修由人工看完报告再决定
 *             （重跑 gen-ext --words / 手改 / 不管）。
 *
 * 断点 = audit 文件本身：同 auditV 且 verdict 为 pass/fail 的跳过；
 * verdict 为 error（调用/解析失败）的续跑会重试。每条落盘，随时可断可续。
 * auditV = VERIFY_PROMPT_VERSION —— 换核查提示词即全部重跑。
 * 每条先过本地 validateWordExt（免费、同样只标记），再上 LLM。
 *
 * 结论分级：
 *   pass   LLM 放行
 *   fail   LLM 列出 issues，或本地校验不过 / 词包查无此词
 *   error  调用或解析失败（网络类直接中断写盘，其余记录后续跑重试）
 *
 * 退出码：0 全部 pass · 3 有 fail/error · 2 网络中断（断点已写盘）
 * 产出文件不入库（与 word-ext.raw.jsonl / .failed.json 同为过程文件）。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { chat, LlmError } from '../app/js/llm/client.js';
import {
  buildVerifyPrompt,
  parseVerifyVerdict,
  VERIFY_PROMPT_VERSION,
} from '../app/js/llm/prompts.js';
import { createQueue } from '../app/js/llm/ratelimit.js';
import { validateWordExt } from '../app/js/llm/validate.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PACK_PATH = join(ROOT, 'app', 'data', 'words.v2.json');
const SOURCE_PATH = join(ROOT, 'data', 'raw', 'word-ext.json');
const OUTPUT_DEFAULT = join(ROOT, 'data', 'raw', 'word-ext.audit.json');

// 核查端点：逐项回落生成端点 —— 与 gen-ext / llm-test 同一套 LLM_VERIFY_* 语义
const genCfg = {
  baseUrl: process.env.LLM_BASE_URL || 'http://127.0.0.1:15721/v1',
  model: process.env.LLM_MODEL || 'agnes-3.0-flash',
  apiKey: process.env.LLM_API_KEY || 'PROXY_MANAGED',
};
const verifyCfg = {
  baseUrl: process.env.LLM_VERIFY_BASE_URL || genCfg.baseUrl,
  model: process.env.LLM_VERIFY_MODEL || genCfg.model,
  apiKey: process.env.LLM_VERIFY_API_KEY || genCfg.apiKey,
};

/* ---------------- CLI ---------------- */

const argv = process.argv.slice(2);
const flag = f => argv.includes(f);
const opt = f => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : null; };

const reportMode = flag('--report');
const force = flag('--force');
const wordsArg = opt('--words');
const limitArg = opt('--limit');
const outArg = opt('--out');
const OUTPUT = outArg ? resolve(ROOT, outArg) : OUTPUT_DEFAULT;

/* ---------------- 纯函数（单测直接 import） ---------------- */

/**
 * 合并断点与本轮结果，顺序对齐源（word-ext.json 的词序）。
 * 本轮结果覆盖同 k 的旧 verdict；源里已经没有的旧条目丢弃（audit 永远对齐数据本体）。
 */
export function mergeAudit(prevWords, results, order) {
  const byK = new Map();
  for (const e of prevWords || []) if (e && e.k && !byK.has(e.k)) byK.set(e.k, e);
  for (const e of results || []) if (e && e.k) byK.set(e.k, e);
  const out = [];
  for (const k of order || []) {
    const e = byK.get(k);
    if (e) out.push(e);
  }
  return out;
}

/**
 * 待核查列表：pass/fail 已定论的跳过；error（调用失败）与缺失的重跑；--force 全跑。
 */
export function selectPending(targets, prevWords, forceFlag) {
  if (forceFlag) return targets.slice();
  const done = new Set();
  for (const e of prevWords || []) {
    if (e && (e.verdict === 'pass' || e.verdict === 'fail')) done.add(e.k);
  }
  return targets.filter(w => !done.has(w.k));
}

/* ---------------- 文件读写 ---------------- */

function loadJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeAudit(entries) {
  const payload = {
    kind: 'word-ext-audit',
    auditV: VERIFY_PROMPT_VERSION,
    model: verifyCfg.model,
    generatedAt: new Date().toISOString(),
    count: entries.length,
    words: entries,
  };
  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, JSON.stringify(payload, null, 1));
  return payload;
}

/* ---------------- --report：离线打印问题清单 ---------------- */

function runReport(source) {
  const data = loadJson(OUTPUT, null);
  if (!data || !Array.isArray(data.words) || !data.words.length) {
    console.error(`没有核查结果：${OUTPUT}`);
    process.exit(1);
  }
  if (data.auditV !== VERIFY_PROMPT_VERSION) {
    console.warn(`注意：结果是 auditV ${data.auditV}（当前 ${VERIFY_PROMPT_VERSION}），核查提示词可能已变`);
  }

  const pass = data.words.filter(e => e.verdict === 'pass');
  const fail = data.words.filter(e => e.verdict === 'fail');
  const err = data.words.filter(e => e.verdict === 'error');
  const total = source ? source.words.length : data.count;
  const audited = new Set(data.words.map(e => e.k));
  const un = source ? source.words.filter(w => !audited.has(w.k)) : [];

  console.log(`核查报告 ${OUTPUT}`);
  console.log(`  auditV ${data.auditV} · model ${data.model} · ${data.generatedAt}`);
  console.log(`  pass ${pass.length} · fail ${fail.length} · error ${err.length} · 未核查 ${un.length} / ${total}`);

  for (const e of [...fail, ...err]) {
    const detail = e.verdict === 'error'
      ? `error：${e.error || '?'}`
      : (e.issues || []).map(i => `${i.field}: ${i.problem}`).join(' ； ');
    console.log(`  ✗ ${e.w}  ${detail}`);
  }
  const retry = [...fail, ...err].map(e => e.w);
  if (retry.length) console.log(`\n重跑清单（粘给 gen-ext --words）：${retry.join('; ')}`);
  process.exit(fail.length || err.length ? 3 : 0);
}

/* ---------------- main ---------------- */

async function main() {
  const source = loadJson(SOURCE_PATH, null);
  if (!source || !Array.isArray(source.words) || !source.words.length) {
    console.error(`读不到数据本体：${SOURCE_PATH}`);
    process.exit(1);
  }
  if (reportMode) runReport(source);

  const pack = JSON.parse(readFileSync(PACK_PATH, 'utf8'));
  const byKey = new Map(pack.words.map(w => [w.k, w]));
  const order = source.words.map(w => w.k);

  let targets = source.words;
  if (wordsArg) {
    const want = new Set(wordsArg.split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
    targets = source.words.filter(w => want.has(w.k));
    for (const k of want) if (!order.includes(k)) console.warn(`  跳过：数据本体里没有 "${k}"`);
  }
  if (limitArg) targets = targets.slice(0, Number(limitArg));
  if (!targets.length) { console.error('没有可核查的词'); process.exit(1); }

  const prevData = loadJson(OUTPUT, null);
  let prevWords = [];
  if (prevData && Array.isArray(prevData.words)) {
    if (prevData.auditV === VERIFY_PROMPT_VERSION) prevWords = prevData.words;
    else console.log(`  已有结果是 auditV ${prevData.auditV}（当前 ${VERIFY_PROMPT_VERSION}），全部重跑`);
  }

  console.log(`[1/3] 数据本体 ${source.words.length} 条 · 核查端点 ${verifyCfg.model} @ ${verifyCfg.baseUrl}`);
  const pending = selectPending(targets, prevWords, force);
  console.log(`[2/3] 本轮目标 ${targets.length}，已定论跳过 ${targets.length - pending.length}，待核查 ${pending.length}（auditV ${VERIFY_PROMPT_VERSION}）`);
  if (!pending.length) {
    writeAudit(mergeAudit(prevWords, [], order));
    console.log('[3/3] 全部已核查');
    return;
  }

  const push = createQueue({ minIntervalMs: Number(process.env.LLM_MIN_INTERVAL || 6500) });
  const results = [];
  const t0Run = Date.now();
  let passN = 0;
  let failN = 0;
  let errN = 0;

  for (let i = 0; i < pending.length; i += 1) {
    const src = pending[i];
    const t0 = Date.now();
    const entry = {
      k: src.k,
      w: src.w,
      at: new Date().toISOString(),
      costMs: 0,
      verdict: 'fail',
      issues: [],
    };

    const finish = (verdict, issues, error) => {
      entry.verdict = verdict;
      entry.issues = issues || [];
      if (error) entry.error = error;
      results.push(entry);
      writeAudit(mergeAudit(prevWords, results, order)); // 每条落盘：长批跑随时可断
      const sec = ((Date.now() - t0) / 1000).toFixed(1);
      if (verdict === 'pass') {
        passN += 1;
        console.log(`[${i + 1}/${pending.length}] ${src.w} ✓ pass · ${sec}s`);
      } else if (verdict === 'fail') {
        failN += 1;
        const detail = entry.issues.map(x => `${x.field}: ${x.problem}`).join(' ； ');
        console.log(`[${i + 1}/${pending.length}] ${src.w} ✗ fail · ${sec}s — ${detail}`);
      } else {
        errN += 1;
        console.log(`[${i + 1}/${pending.length}] ${src.w} ✗ error · ${sec}s — ${error}`);
      }
      if ((i + 1) % 20 === 0) {
        const elapsed = Date.now() - t0Run;
        const remainMin = Math.round((pending.length - i - 1) * (elapsed / (i + 1)) / 60000);
        console.log(`  ── 进度 ${i + 1}/${pending.length} · 已用 ${Math.round(elapsed / 60000)} 分钟 · 预计还需 ${remainMin} 分钟 ──`);
      }
    };

    // 1) 词包 grounding：没有官方义项就无从核查
    const word = byKey.get(src.k);
    if (!word) {
      finish('fail', [{ field: 'k', problem: '词包无此词，无法构建官方义项' }]);
      continue;
    }

    // 2) 本地校验（免费，同样只标记不上报）
    let local;
    try {
      local = validateWordExt({ zh: src.zh, family: src.family, etymology: src.etymology }, src.k);
    } catch (err) {
      finish('error', [], `本地校验抛错：${err.message}`);
      continue;
    }
    if (!local.ok) {
      finish('fail', local.errors.map(msg => ({ field: '本地校验', problem: msg })));
      continue;
    }

    // 3) LLM 背靠背核查
    try {
      const messages = buildVerifyPrompt(word, {
        zh: src.zh, family: src.family, etymology: src.etymology,
      });
      const tCall = Date.now();
      const content = await push(() => chat(messages, verifyCfg, { json: true, timeoutMs: 90000 }));
      entry.costMs = Date.now() - tCall;
      let verdict;
      try {
        verdict = parseVerifyVerdict(content);
      } catch (err) {
        finish('error', [], `结论解析失败：${err.message}`);
        continue;
      }
      if (verdict.pass) finish('pass', []);
      else finish('fail', verdict.issues);
    } catch (err) {
      if (err instanceof LlmError && err.code === 'NETWORK') {
        results.push({ ...entry, verdict: 'error', issues: [], error: err.message });
        writeAudit(mergeAudit(prevWords, results, order));
        console.error(`  ✗ 中断：${err.message}`);
        console.error('  进度已写入 audit 文件，重跑同一命令自动续上');
        process.exit(2);
      }
      finish('error', [], err.message);
    }
  }

  const payload = writeAudit(mergeAudit(prevWords, results, order));
  const failAll = payload.words.filter(e => e.verdict !== 'pass');
  console.log(`[3/3] 本轮 pass ${passN} · fail ${failN} · error ${errN}；文件累计 ${payload.count} 条（pass ${payload.count - failAll.length} / 待处理 ${failAll.length}）`);
  if (failAll.length) console.log(`     问题清单：${OUTPUT}\n     查看：node scripts/audit-ext.mjs --report`);
  if (failAll.length) process.exitCode = 3;
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
