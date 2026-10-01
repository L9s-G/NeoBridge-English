#!/usr/bin/env node
/**
 * 词源字段批量生成（facts 有据改写）—— 只动产物的 etymology 字段，zh/family 不碰。
 *
 *   node scripts/gen-ety.mjs                    # 全部待生成词 → data/raw/word-ext.json
 *   node scripts/gen-ety.mjs --words a,b,c      # 指定词（调试 / 审出问题后的返工）
 *   node scripts/gen-ety.mjs --limit 5          # 只跑前 N 个待生成（冒烟）
 *   node scripts/gen-ety.mjs --out data/raw/word-ety.test.json   # 写测试产物（缺则自动从正本拷）
 *   node scripts/gen-ety.mjs --force            # 已有词源也重新生成
 *   # 端点 / 节流（云端跑时按接入点设置）：
 *   LLM_BASE_URL=https://.../v1 LLM_MODEL=xxx LLM_API_KEY=sk-... \
 *     LLM_MIN_INTERVAL=6500 LLM_JSON_MODE=0 node scripts/gen-ety.mjs
 *
 * 事实底稿 data/raw/word-ety-facts.json（English Wiktionary MediaWiki API，验收报告 word-ety-facts.report.md）：
 *   义项过滤（uncertain:true 不送）→ path 代码预排（倒序 + 语言白名单 + 链首保底）→
 *   text 清洗（砍 Cognate/Related 旁系句；剔除含星号形 · Proto-* · PIE 的子句）→ zh 只给首句。
 *   LLM 只写 origin + story、照抄 path 并把 meaning 译成中文。
 * 口径 = scripts/ety-gen.txt（改它即改口径，etyPromptV 自动跟着变，旧产物会提示口径过期）。
 *
 * 校验环（每词 ≤5 轮，未过带定向反馈重试）：
 *   JSON 解析 → path post-fix（结构用预排覆盖、meaning 非中文回退 ""）→ validateWordExt →
 *   硬红线 lint（星号 / Proto- / 原始印欧语 正则，命中即要求重写）。
 *
 * 断点 = 产物本身：etymology 非空即跳过（--force 除外）；失败词进 <产物>.failed.json
 * 且 etymology 保持空 → 重跑同命令自动补。每词落盘，随时可断。
 * 跑完换接入点核查：node scripts/audit-ety.mjs（见该脚本头部）。
 * 退出码：0 全部成功 · 3 有失败 · 2 连接/鉴权类中断（进度已写盘）
 */

import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chat, LlmError } from '../app/js/llm/client.js';
import { createQueue } from '../app/js/llm/ratelimit.js';
import { validateWordExt } from '../app/js/llm/validate.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RAW = join(ROOT, 'data', 'raw');
const FACTS_PATH = join(RAW, 'word-ety-facts.json');
const PROMPT_PATH = join(ROOT, 'scripts', 'ety-gen.txt');
const DEFAULT_OUT = join(RAW, 'word-ext.json');

const genCfg = {
  baseUrl: process.env.LLM_BASE_URL || 'http://127.0.0.1:15721/v1',
  model: process.env.LLM_MODEL || 'agnes-3.0-flash',
  apiKey: process.env.LLM_API_KEY || 'PROXY_MANAGED',
};
const useJsonMode = process.env.LLM_JSON_MODE !== '0';

/* ---------------- CLI ---------------- */

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : null; };

const wordsArg = opt('--words');
const limitArg = opt('--limit');
const outArg = opt('--out');
const force = flag('--force');
const OUT = outArg ? resolve(ROOT, outArg) : DEFAULT_OUT;
const FAILED_FILE = OUT.replace(/\.json$/, '.failed.json');
const RAW_LOG = OUT.replace(/\.json$/, '.raw.jsonl');

/* ---------------- facts 预处理：path 预排 / text 清洗 / 输入瘦身 ---------------- */

// 语言白名单（已拍板：Old Norse / 苏格兰系 / 印地乌尔都 / 韩语 保留）
const KEEP_EXACT = new Set([
  'en', 'fro', 'frm', 'xno', 'fr', 'grc', 'el', 'gkm', 'la',
  'de', 'nds', 'it', 'es', 'pt', 'nl', 'af',
  'ar', 'he', 'ru', 'ja', 'zh', 'yue', 'sa',
  'non', 'hi', 'ur', 'sco', 'gmw-msc', 'ko',
]);
const KEEP_PREFIX = ['en', 'ang', 'la-', 'fro', 'roa-oit', 'es', 'fr'];
const isKeep = (code) =>
  KEEP_EXACT.has(code) ||
  KEEP_PREFIX.some((p) => code.startsWith(p)) ||
  code.split(/[,.\s]/).some((part) => KEEP_EXACT.has(part));

// 倒序（源头在前）+ 白名单 + 链首保底（逆序后末位 = 最贴近英语的形）
const buildPath = (chain) =>
  [...chain].reverse()
    .filter((l, i, arr) => isKeep(l.code) || i === arr.length - 1)
    .map((l) => ({ form: l.form, lang: l.lang, meaning: l.meaning || '' }));

// text 清洗①：含禁用形（星号/Proto-*/PIE）的子句整条剔除 —— 输入干净输出才干净
const hasBan = (s) => /[*＊]|Proto-|Indo-European|\bPIE\b/i.test(s);
const sanitizeText = (t) => {
  if (!t) return t;
  const out = [];
  for (const s0 of t.match(/[^.]+\.?/g) || [t]) {
    if (!hasBan(s0)) { out.push(s0); continue; }
    const kept = s0.split(/(?=,\s*from\s)/i).filter((c) => !hasBan(c));
    if (kept.length) out.push(kept.join(''));
  }
  return out.join(' ').replace(/\s+/g, ' ').trim();
};

// text 清洗②：旁系句（同源词/比较/相关词/用法）整句砍掉，只留主线事实
const SIDE_SENT = /^(Cognate|Compare|Related|See also|Derived|Usage|Not to be confused|Ancestor|Descendant|Equivalent to the)/i;
const slimText = (t) => {
  if (!t) return t;
  const sents = t.match(/[^.!?]+[.!?]*/g) || [t];
  return sents.filter((s) => !SIDE_SENT.test(s.trim())).join(' ').replace(/\s+/g, ' ').trim();
};

const slimZh = (z) => {
  const s = String(z || '').split('。')[0];
  return s ? s + '。' : '';
};

/* ---------------- 工具 ---------------- */

const loadJson = (file, fallback) => {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
};

const parseModelJson = (raw) => {
  const m = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const s = m.indexOf('{');
  const e = m.lastIndexOf('}');
  if (s < 0 || e < 0) throw new Error('输出里找不到 JSON');
  return JSON.parse(m.slice(s, e + 1));
};

// 硬红线 lint：正则可查，不靠 LLM 眼力
const lintFind = (ety) => {
  const hits = new Set();
  const t = `${ety.origin || ''}\n${ety.story || ''}`;
  if (/[*＊]\s*[a-zA-Z]/.test(t)) hits.add('星号重建形（*xxx）');
  if (/Proto-[A-Za-z]/.test(t)) hits.add('Proto- 重建语');
  if (/原始印欧语|\bPIE\b/.test(t)) hits.add('原始印欧语（PIE）');
  return [...hits];
};

// path post-fix：结构用预排覆盖，只按 form 收 LLM 的中文释义；非中文回退 ""
const postFixPath = (ety, expected) => {
  const llmPath = Array.isArray(ety.path) ? ety.path : [];
  const meaningBy = new Map(llmPath.map((p) => [p && p.form, typeof (p && p.meaning) === 'string' ? p.meaning : '']));
  const hasCJK = (s) => /[\u4e00-\u9fff]/.test(s);
  ety.path = expected.map((e) => {
    const m = meaningBy.get(e.form) || '';
    return { form: e.form, lang: e.lang, meaning: m && hasCJK(m) ? m : '' };
  });
  return JSON.stringify(llmPath) !== JSON.stringify(expected);
};

const appendRaw = (k, rec) => {
  try { appendFileSync(RAW_LOG, JSON.stringify(rec) + '\n'); } catch { /* 留痕失败不影响建库 */ }
};

const loadFailed = () => loadJson(FAILED_FILE, { words: [] }).words || [];
const writeFailed = (entries) => {
  writeFileSync(FAILED_FILE, JSON.stringify({
    kind: 'word-ety-failed',
    etyPromptV: promptV,
    model: genCfg.model,
    generatedAt: new Date().toISOString(),
    count: entries.length,
    words: entries,
  }, null, 1));
};

const hasEty = (e) => !!(e.etymology && (e.etymology.origin || e.etymology.story || (e.etymology.path || []).length));

/* ---------------- main ---------------- */

const SYSTEM = readFileSync(PROMPT_PATH, 'utf8');
const promptV = createHash('sha1').update(SYSTEM).digest('hex').slice(0, 8);

async function main() {
  console.log(`[1/4] 底稿 ${FACTS_PATH}`);
  const facts = loadJson(FACTS_PATH, null);
  if (!facts || !facts.words) { console.error('读不到事实底稿'); process.exit(1); }

  if (!existsSync(OUT)) {
    copyFileSync(DEFAULT_OUT, OUT);
    console.log(`  测试产物不存在，已从正本拷贝 → ${OUT}`);
  }
  const data = loadJson(OUT, null);
  if (!data || !Array.isArray(data.words)) { console.error(`读不到产物 ${OUT}`); process.exit(1); }
  if (data.etyPromptV && data.etyPromptV !== promptV) {
    console.warn(`  ⚠ 产物是 etyPromptV ${data.etyPromptV}（当前 ${promptV}）：旧词源按旧口径生成，如需统一口径请 --force`);
  }
  console.log(`  生成端点 ${genCfg.model} @ ${genCfg.baseUrl} · etyPromptV ${promptV} · 节流 ${process.env.LLM_MIN_INTERVAL || 6500}ms · json模式 ${useJsonMode ? '开' : '关'}`);

  const want = wordsArg ? new Set(wordsArg.split(',').map((s) => s.trim()).filter(Boolean)) : null;
  const stats = { noFacts: 0, allUncertain: 0, done: 0 };
  const pending = [];
  for (const e of data.words) {
    if (want && !want.has(e.k)) continue;
    const f = facts.words[e.k];
    if (!f || !f.etymologies.length) { stats.noFacts += 1; continue; }
    if (!f.etymologies.some((x) => !x.uncertain)) { stats.allUncertain += 1; continue; }
    if (!force && hasEty(e)) { stats.done += 1; continue; }
    pending.push(e);
  }
  const limit = limitArg ? Number(limitArg) : Infinity;
  const targets = pending.slice(0, limit);
  console.log(`[2/4] 待生成 ${targets.length} · 已有词源 ${stats.done} · 无事实依据 ${stats.noFacts} · 全义项存疑跳过 ${stats.allUncertain}`);
  if (!targets.length) { console.log('[4/4] 无需生成'); return; }

  let failed = loadFailed();
  const failedKeys = new Set(failed.map((x) => x.k));
  // RPM 10 → 默认 6.5s 间隔（与 gen-ext/audit-ext 同一约定，ratelimit.js 同一队列）；
  // 只有上游明确放开限速时才用 LLM_MIN_INTERVAL 调快
  const push = createQueue({ minIntervalMs: Number(process.env.LLM_MIN_INTERVAL || 6500) });

  const writeOut = () => {
    data.etyPromptV = promptV;
    data.etyGeneratedAt = new Date().toISOString();
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(data, null, 1));
  };

  console.log(`[3/4] 产物 ${OUT} · 失败清单 ${FAILED_FILE}`);
  let okN = 0;
  let failN = 0;
  const t0Run = Date.now();

  for (let i = 0; i < targets.length; i += 1) {
    const e = targets[i];
    const t0 = Date.now();
    const f = facts.words[e.k];
    const etys = f.etymologies.filter((x) => !x.uncertain);
    const etyIn = etys.map((x) => ({
      pos: x.pos,
      path: buildPath(x.chain),
      composition: x.composition,
      text: sanitizeText(slimText(x.text)),
    }));
    const expected = etyIn[0].path;
    const user = `word: ${e.k}\nzh: ${slimZh(e.zh)}\nfacts: ${JSON.stringify({ etymologies: etyIn })}`;

    let out = null;
    let feedback = '';
    let lastErr = null;
    let fatal = null;
    const rounds = [];

    for (let round = 1; round <= 5 && !out; round += 1) {
      const tc = Date.now();
      try {
        const content = await push(() => chat(
          [{ role: 'system', content: SYSTEM }, { role: 'user', content: user + feedback }],
          genCfg,
          { json: useJsonMode, timeoutMs: 90000 },
        ));
        const ety = parseModelJson(content);
        postFixPath(ety, expected);

        const errs = [];
        const v = validateWordExt({ zh: e.zh, family: e.family || [], etymology: ety }, e.k);
        if (!v.ok) errs.push(...v.errors);
        const lint = lintFind(ety);
        if (lint.length) errs.push(`包含禁用内容：${lint.join('、')}，请删掉这些内容重写`);
        if (!ety.origin && !ety.story && !(ety.path || []).length) errs.push('origin 和 story 不能全空');

        rounds.push({ round, at: new Date().toISOString(), costMs: Date.now() - tc, errs });
        appendRaw(e.k, { round, at: new Date().toISOString(), costMs: Date.now() - tc, content: errs.length ? { raw: content, errs } : ety });

        if (errs.length) {
          lastErr = errs.join('；');
          feedback = `\n\n上一次输出未通过校验：${lastErr}。请修正后重新输出完整 JSON。`;
          console.log(`  [轮${round}] ✗ ${lastErr}`);
          continue;
        }
        out = ety;
      } catch (err) {
        if (err instanceof LlmError && (err.code === 'NETWORK' || err.code === 'AUTH')) {
          fatal = err;
          break;
        }
        lastErr = err.message || String(err);
        rounds.push({ round, at: new Date().toISOString(), costMs: Date.now() - tc, error: lastErr });
        appendRaw(e.k, { round, at: new Date().toISOString(), costMs: Date.now() - tc, error: lastErr });
        console.log(`  [轮${round}] ✗ ${lastErr}`);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }

    if (fatal) {
      writeOut();
      console.error(`  ✗ 中断：${fatal.message}`);
      console.error(`  进度已写入 ${OUT}，重跑同一命令自动续上`);
      process.exit(2);
    }

    if (out) {
      e.etymology = out;
      writeOut();
      okN += 1;
      failedKeys.delete(e.k);
      if (failed.some((x) => x.k === e.k)) {
        failed = failed.filter((x) => x.k !== e.k);
        writeFailed(failed);
      }
      const story = out.story ? `${out.story.length} 字` : '空';
      console.log(`[${i + 1}/${targets.length}] ${e.k} ✓ origin ${out.origin.length} 字，story ${story} · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } else {
      failN += 1;
      failedKeys.add(e.k);
      failed = [...failed.filter((x) => x.k !== e.k), {
        k: e.k,
        w: e.w,
        etyPromptV: promptV,
        model: genCfg.model,
        at: new Date().toISOString(),
        error: lastErr || '未知失败',
        rounds,
      }];
      writeFailed(failed);
      console.log(`[${i + 1}/${targets.length}] ${e.k} ✗ 进人工清单（etymology 保持空，重跑自动补）`);
    }

    if ((i + 1) % 20 === 0) {
      const elapsed = Date.now() - t0Run;
      const remainMin = Math.round((targets.length - i - 1) * (elapsed / (i + 1)) / 60000);
      console.log(`  ── 进度 ${i + 1}/${targets.length} · 已用 ${Math.round(elapsed / 60000)} 分钟 · 预计还需 ${remainMin} 分钟 ──`);
    }
  }

  writeOut();
  console.log(`[4/4] 本轮成功 ${okN}，失败 ${failN}`);
  if (failed.length) console.log(`     失败清单 ${FAILED_FILE}（${failed.length} 条）；返工：node scripts/gen-ety.mjs --words ${failed.slice(0, 5).map((x) => x.k).join(',')}${failed.length > 5 ? ',…' : ''} --force`);
  if (failN) process.exitCode = 3;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
