#!/usr/bin/env node
/**
 * 词源字段核查（只标记不改数据）—— 与生成分开跑、推荐换一个接入点（另一家模型）复核，
 * 两边同源错误才能对冲；LLM 审 LLM 只是概率工具，硬红线仍由本地正则先抓。
 *
 *   node scripts/audit-ety.mjs                       # 核查产物里所有有词源的词
 *   node scripts/audit-ety.mjs --words a,b,c          # 指定词
 *   node scripts/audit-ety.mjs --limit 20             # 抽样
 *   node scripts/audit-ety.mjs --report               # 只打印已有结果的问题清单（不联网）
 *   node scripts/audit-ety.mjs --force                # 已有 verdict 也重跑
 *   node scripts/audit-ety.mjs --src data/raw/word-ety.test.json --out data/raw/word-ety.test.audit.json
 *   # 换接入点（与生成不同家）：
 *   LLM_VERIFY_BASE_URL=https://.../v1 LLM_VERIFY_MODEL=xxx LLM_VERIFY_API_KEY=sk-... \
 *     node scripts/audit-ety.mjs
 *   # 节流默认 RPM 10（6.5s 间隔，与 gen-ext/audit-ext 一致）；上游明确放开限速才 LLM_MIN_INTERVAL 调小
 *
 * 每词流程：
 *   1) 本地（零成本）：validateWordExt + 硬红线 lint（星号 / Proto- / PIE 正则）→ 命中直接 fail
 *   2) LLM 背靠背：prompt = scripts/ety-audit.txt，只给 facts + rewritten（不给生成 prompt）
 *
 * 断点 = verdicts 文件：verdict 为 pass/fail 且 etyHash（词源内容指纹）未变 → 跳过；
 * 生成侧重跑后指纹变化自动失效、强制重核。error（调用失败）续跑总是重试。
 * 结论：pass 放行 · fail 列 issues 交人工（返工：gen-ety --words <fail清单> --force 后重核）·
 *       error 调用失败。产出只标记，绝不改数据本体。
 * 退出码：0 全 pass · 3 有 fail/error · 2 连接/鉴权类中断（进度已写盘）
 */

import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { chat, LlmError } from '../app/js/llm/client.js';
import { createQueue } from '../app/js/llm/ratelimit.js';
import { validateWordExt } from '../app/js/llm/validate.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RAW = join(ROOT, 'data', 'raw');
const FACTS_PATH = join(RAW, 'word-ety-facts.json');
const PROMPT_PATH = join(ROOT, 'scripts', 'ety-audit.txt');

const genCfg = {
  baseUrl: process.env.LLM_BASE_URL || 'http://127.0.0.1:15721/v1',
  model: process.env.LLM_MODEL || 'agnes-3.0-flash',
  apiKey: process.env.LLM_API_KEY || 'PROXY_MANAGED',
};
// 核查接入点：逐项回落生成端点 —— 换一家只需设 LLM_VERIFY_*
const verifyCfg = {
  baseUrl: process.env.LLM_VERIFY_BASE_URL || genCfg.baseUrl,
  model: process.env.LLM_VERIFY_MODEL || genCfg.model,
  apiKey: process.env.LLM_VERIFY_API_KEY || genCfg.apiKey,
};
const useJsonMode = process.env.LLM_JSON_MODE !== '0';

/* ---------------- CLI ---------------- */

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : null; };

const reportMode = flag('--report');
const force = flag('--force');
const wordsArg = opt('--words');
const limitArg = opt('--limit');
const srcArg = opt('--src');
const outArg = opt('--out');
const SRC = srcArg ? resolve(ROOT, srcArg) : join(RAW, 'word-ext.json');
const OUTPUT = outArg ? resolve(ROOT, outArg) : join(RAW, 'word-ety.audit.json');

const SYSTEM = readFileSync(PROMPT_PATH, 'utf8');
const auditV = createHash('sha1').update(SYSTEM).digest('hex').slice(0, 8);

const loadJson = (file, fallback) => {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
};

const etyHashOf = (ety) => createHash('sha1').update(JSON.stringify(ety)).digest('hex').slice(0, 12);

// 硬红线 lint（与 gen-ety 同一套）——确定性的先抓，不花 LLM；path 本地查 meaning 中文
const lintFind = (ety) => {
  const hits = new Set();
  const t = `${ety.origin || ''}\n${ety.story || ''}`;
  if (/[*＊]\s*[a-zA-Z]/.test(t)) hits.add('星号重建形（*xxx）');
  if (/Proto-[A-Za-z]/.test(t)) hits.add('Proto- 重建语');
  if (/原始印欧语|\bPIE\b/.test(t)) hits.add('原始印欧语（PIE）');
  for (const p of ety.path || []) {
    if (p.meaning && !/[一-鿿]/.test(p.meaning)) hits.add(`path.meaning 非中文（${p.form}: ${p.meaning}）`);
  }
  return [...hits];
};

const parseVerdict = (raw) => {
  const m = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const s = m.indexOf('{');
  const e = m.lastIndexOf('}');
  if (s < 0 || e < 0) throw new Error('结论里找不到 JSON');
  const v = JSON.parse(m.slice(s, e + 1));
  if (typeof v.pass !== 'boolean' || !Array.isArray(v.issues)) throw new Error('verdict 结构异常');
  return v;
};

const writeAudit = (words) => {
  writeFileSync(OUTPUT, JSON.stringify({
    kind: 'word-ety-audit',
    auditV,
    model: verifyCfg.model,
    generatedAt: new Date().toISOString(),
    count: words.length,
    words,
  }, null, 1));
};

function runReport(source) {
  const data = loadJson(OUTPUT, null);
  if (!data || !Array.isArray(data.words) || !data.words.length) {
    console.error(`没有核查结果：${OUTPUT}`);
    process.exit(1);
  }
  if (data.auditV !== auditV) console.warn(`注意：结果是 auditV ${data.auditV}（当前 ${auditV}），核查口径可能已变`);
  const pass = data.words.filter((x) => x.verdict === 'pass');
  const fail = data.words.filter((x) => x.verdict === 'fail');
  const err = data.words.filter((x) => x.verdict === 'error');
  const audited = new Map(data.words.map((x) => [x.k, x]));
  const un = source.words.filter((w) => !audited.has(w.k));
  console.log(`核查报告 ${OUTPUT}`);
  console.log(`  auditV ${data.auditV} · model ${data.model} · ${data.generatedAt}`);
  console.log(`  pass ${pass.length} · fail ${fail.length} · error ${err.length} · 未核查 ${un.length}`);
  for (const x of [...fail, ...err]) {
    const detail = x.verdict === 'error'
      ? `error：${x.error || '?'}`
      : (x.issues || []).map((i) => `${i.field}: ${i.problem}`).join(' ； ');
    console.log(`  ✗ ${x.k}  ${detail}`);
  }
  const retry = [...fail, ...err].map((x) => x.k);
  if (retry.length) console.log(`\n返工清单（生成侧重跑后本脚本会按指纹自动重核）：\n  node scripts/gen-ety.mjs --words ${retry.join(',')} --force`);
  process.exit(fail.length || err.length ? 3 : 0);
}

/* ---------------- main ---------------- */

async function main() {
  const source = loadJson(SRC, null);
  if (!source || !Array.isArray(source.words) || !source.words.length) { console.error(`读不到产物 ${SRC}`); process.exit(1); }
  if (reportMode) runReport(source);

  const facts = loadJson(FACTS_PATH, null);
  if (!facts || !facts.words) { console.error('读不到事实底稿'); process.exit(1); }
  console.log(`[1/3] 产物 ${SRC} · 底稿 ${FACTS_PATH} · auditV ${auditV}`);
  console.log(`  核查接入点 ${verifyCfg.model} @ ${verifyCfg.baseUrl}${verifyCfg.baseUrl !== genCfg.baseUrl || verifyCfg.model !== genCfg.model ? '（与生成不同，✓）' : '（⚠ 与生成同端点，建议换一家）'}`);

  const prev = loadJson(OUTPUT, null);
  const prevWords = prev && prev.auditV === auditV && Array.isArray(prev.words) ? prev.words : [];
  if (prev && prev.auditV !== auditV) console.log(`  已有结果是 auditV ${prev.auditV}（当前 ${auditV}），全部重跑`);

  const want = wordsArg ? new Set(wordsArg.split(',').map((s) => s.trim()).filter(Boolean)) : null;
  let targets = source.words.filter((e) => {
    if (want && !want.has(e.k)) return false;
    const ety = e.etymology;
    return !!(ety && (ety.origin || ety.story || (ety.path || []).length));
  });
  if (limitArg) targets = targets.slice(0, Number(limitArg));
  const skipNoEty = source.words.length - source.words.filter((e) => e.etymology && (e.etymology.origin || e.etymology.story || (e.etymology.path || []).length)).length;

  const done = new Map(prevWords.map((x) => [x.k, x]));
  const pending = force ? targets : targets.filter((e) => {
    const d = done.get(e.k);
    return !(d && (d.verdict === 'pass' || d.verdict === 'fail') && d.etyHash === etyHashOf(e.etymology));
  });
  console.log(`[2/3] 可核查 ${targets.length}（无词源跳过 ${skipNoEty}），断点命中 ${targets.length - pending.length}，待核查 ${pending.length}`);
  if (!pending.length) { writeAudit([...done.values()]); console.log('[3/3] 全部已核查'); return; }

  // RPM 10 → 默认 6.5s 间隔（与 gen-ext/audit-ext 同一约定，ratelimit.js 同一队列）
  const push = createQueue({ minIntervalMs: Number(process.env.LLM_MIN_INTERVAL || 6500) });
  const results = [];
  let passN = 0;
  let failN = 0;
  let errN = 0;
  const t0Run = Date.now();

  for (let i = 0; i < pending.length; i += 1) {
    const e = pending[i];
    const t0 = Date.now();
    const entry = { k: e.k, w: e.w, etyHash: etyHashOf(e.etymology), at: new Date().toISOString(), verdict: 'error', issues: [] };

    // 1) 本地：结构校验 + 硬红线（零成本，先于 LLM）
    const local = validateWordExt({ zh: e.zh, family: e.family || [], etymology: e.etymology }, e.k);
    const lint = lintFind(e.etymology);
    if (!local.ok || lint.length) {
      entry.verdict = 'fail';
      entry.issues = [
        ...local.errors.map((msg) => ({ field: '本地校验', problem: msg })),
        ...lint.map((h) => ({ field: 'lint', problem: `硬红线命中：${h}` })),
      ];
      results.push(entry);
      done.set(e.k, entry);
      writeAudit([...done.values()]);
      failN += 1;
      console.log(`[${i + 1}/${pending.length}] ${e.k} ✗ fail（本地） — ${entry.issues.map((x) => x.problem).join(' ； ')}`);
      continue;
    }

    // 2) LLM 背靠背核查（facts 全量 + rewritten 的 origin/story；path 代码产物不给它看）
    const user = `word: ${e.k}\nzh: ${e.zh}\nfacts: ${JSON.stringify(facts.words[e.k])}\nrewritten: ${JSON.stringify({ origin: e.etymology.origin, story: e.etymology.story })}`;
    let lastErr = null;
    let fatal = null;
    for (let attempt = 1; attempt <= 3 && entry.verdict === 'error'; attempt += 1) {
      const tc = Date.now();
      try {
        const content = await push(() => chat(
          [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }],
          verifyCfg,
          { json: useJsonMode, timeoutMs: 90000 },
        ));
        const v = parseVerdict(content);
        entry.costMs = Date.now() - tc;
        entry.verdict = v.pass ? 'pass' : 'fail';
        entry.issues = v.pass ? [] : v.issues;
      } catch (err) {
        if (err instanceof LlmError && (err.code === 'NETWORK' || err.code === 'AUTH')) { fatal = err; break; }
        lastErr = err.message || String(err);
        console.log(`  [试${attempt}] ✗ ${lastErr}`);
        await new Promise((r) => setTimeout(r, 4000));
      }
    }

    if (fatal) {
      results.push({ ...entry, verdict: 'error', error: fatal.message });
      done.set(e.k, { ...entry, verdict: 'error', error: fatal.message });
      writeAudit([...done.values()]);
      console.error(`  ✗ 中断：${fatal.message}`);
      console.error('  进度已写盘，重跑同一命令自动续上');
      process.exit(2);
    }

    if (entry.verdict === 'pass') passN += 1;
    else if (entry.verdict === 'fail') failN += 1;
    else { entry.error = lastErr || '未知错误'; errN += 1; }
    results.push(entry);
    done.set(e.k, entry);
    writeAudit([...done.values()]);

    if (entry.verdict === 'pass') console.log(`[${i + 1}/${pending.length}] ${e.k} ✓ pass · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    else if (entry.verdict === 'fail') console.log(`[${i + 1}/${pending.length}] ${e.k} ✗ fail · ${entry.issues.map((x) => `${x.field}: ${x.problem}`).join(' ； ')}`);
    else console.log(`[${i + 1}/${pending.length}] ${e.k} ✗ error · ${entry.error}`);

    await new Promise((r) => setTimeout(r, 2000)); // 词间节流，防限流
    if ((i + 1) % 20 === 0) {
      const elapsed = Date.now() - t0Run;
      const remainMin = Math.round((pending.length - i - 1) * (elapsed / (i + 1)) / 60000);
      console.log(`  ── 进度 ${i + 1}/${pending.length} · 已用 ${Math.round(elapsed / 60000)} 分钟 · 预计还需 ${remainMin} 分钟 ──`);
    }
  }

  writeAudit([...done.values()]);
  const all = [...done.values()];
  const failAll = all.filter((x) => x.verdict !== 'pass');
  console.log(`[3/3] 本轮 pass ${passN} · fail ${failN} · error ${errN}；累计 ${all.length} 条（pass ${all.length - failAll.length} / 待处理 ${failAll.length}）`);
  if (failAll.length) console.log(`     查看：node scripts/audit-ety.mjs --report`);
  if (failAll.length) process.exitCode = 3;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
