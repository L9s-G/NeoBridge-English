/**
 * 词级扩展数据的建库管线 —— gen-ext.mjs 与 llm-test.html 共用同一实现。
 *
 *   生成轮 → parse + validate
 *     ├─ 致命问题（zh/story 缺失超限、URL）→ 带问题清单反馈，整词重新生成
 *     ├─ 局部问题（family 项超长/坏形态）→ 定向修复（缩写/改正，好数据不动）
 *     │     复验仍不过 → 降级为整词重新生成
 *     └─ 本地合格 → 背靠背核查（verifyCfg 独立端点，只给义项+数据，不给生成 prompt）
 *              ├─ pass → 产出
 *              └─ issues → 带 issues 整词重新生成（核查轮预算内）
 *
 * 预算（PIPELINE_BUDGETS）用尽仍未合格 → {ok:false, rounds[]}，
 * 由调用方写进人工处理清单；网络类错误直接抛出（服务没开，重试无意义）。
 *
 * onEvent 订阅进度：round / call / result / checked / verdict / done ——
 * 脚本侧记日志与 raw 留痕，页面侧渲染管线轨迹。
 */

import { chat, LlmError } from './client.js';
import {
  buildRepairPrompt,
  buildVerifyPrompt,
  buildWordExtPrompt,
  parseRepairItems,
  parseVerifyVerdict,
  parseWordExt,
} from './prompts.js';
import { validateWordExt } from './validate.js';

export const PIPELINE_BUDGETS = Object.freeze({
  genRounds: 3,  // 整词重新生成最多 3 轮（核查反馈共用这个预算）
  repairs: 2,    // 定向修复全局最多 2 次
  verifyRounds: 2, // 核查最多 2 次
});

const FEEDBACK_TAIL = '请修正后重新输出完整 JSON（zh / family / etymology 三个顶层键缺一不可，family 与 story 内容仍可为空）。';

/**
 * 跑完一个词的全部管线。
 *
 * @param word    词包 word（k / w / senses…）
 * @param phrases 官方短语家族（buildWordExtPrompt 的 grounding）
 * @param opts    { push, genCfg, verifyCfg?, budgets?, onEvent?, skipVerify?, timeoutMs?, chatImpl? }
 * @returns 成功 {ok:true, data, stats, rounds}；预算尽 {ok:false, error, stats, rounds, verifyIssues}
 * @throws  LlmError NETWORK（上游不通时快速失败）
 */
export async function runWordPipeline(word, phrases, opts) {
  const {
    push,
    genCfg,
    verifyCfg = genCfg,
    budgets = {},
    onEvent = () => {},
    skipVerify = false,
    timeoutMs = 90000,
    chatImpl = chat,
  } = opts || {};
  if (typeof push !== 'function') throw new Error('runWordPipeline: 缺 push（限速队列）');
  if (!genCfg) throw new Error('runWordPipeline: 缺 genCfg');

  const B = { ...PIPELINE_BUDGETS, ...budgets };
  const stats = { calls: 0, costMs: 0, genRounds: 0, repairs: 0, verifyRounds: 0 };
  const rounds = []; // 诊断轨迹（失败时随结果返回，进人工清单）
  const emit = (ev) => { try { onEvent(ev); } catch { /* 订阅者异常不拖垮管线 */ } };

  const baseMessages = buildWordExtPrompt(word, phrases);
  let lastContent = null;  // 最近一版生成输出（解析成功才留，拼反馈用）
  let feedback = null;     // string[] —— 下一轮生成要修的问题清单
  let data = null;         // 最近一次本地合格的数据
  let lastNotes = [];      // 最近一轮失败原因（gen 预算用尽时回报）
  let verifyIssues = [];

  const call = (cfg, messages, stage) => {
    const round = stage === 'gen' ? stats.genRounds
      : stage === 'repair' ? stats.repairs : stats.verifyRounds;
    stats.calls += 1;
    emit({ type: 'call', stage, round });
    return push(async () => {
      const t0 = Date.now();
      try {
        const content = await chatImpl(messages, cfg, { json: true, timeoutMs });
        const costMs = Date.now() - t0;
        stats.costMs += costMs;
        emit({ type: 'result', stage, round, ok: true, costMs, content });
        return content;
      } catch (err) {
        const costMs = Date.now() - t0;
        stats.costMs += costMs;
        emit({ type: 'result', stage, round, ok: false, costMs, error: err.message });
        throw err;
      }
    });
  };

  const genMessages = () => {
    if (!feedback || !feedback.length) return baseMessages;
    const noteText = `上一版输出有以下问题：\n${feedback.map(n => `- ${n}`).join('\n')}\n${FEEDBACK_TAIL}`;
    if (!lastContent) return [...baseMessages, { role: 'user', content: noteText }];
    return [
      ...baseMessages,
      { role: 'assistant', content: lastContent },
      { role: 'user', content: noteText },
    ];
  };

  const noteNetwork = (err) => {
    if (err instanceof LlmError && err.code === 'NETWORK') throw err;
  };

  while (stats.genRounds < B.genRounds) {
    stats.genRounds += 1;
    const round = stats.genRounds;
    emit({ type: 'round', stage: 'gen', round });

    /* --- 生成 --- */
    let content;
    try {
      content = await call(genCfg, genMessages(), 'gen');
    } catch (err) {
      noteNetwork(err);
      rounds.push({ stage: 'gen', round, error: err.message });
      lastNotes = [`生成调用失败：${err.message}`];
      feedback = lastNotes;
      lastContent = null;
      continue;
    }

    let result;
    try {
      result = validateWordExt(parseWordExt(content), word.k);
    } catch (err) {
      noteNetwork(err);
      rounds.push({ stage: 'gen', round, error: `解析失败：${err.message}` });
      emit({ type: 'checked', stage: 'gen', round, ok: false, fatal: [`解析失败：${err.message}`], flagged: [] });
      lastNotes = [`输出无法解析（${err.message}），请只输出合法 JSON`];
      feedback = lastNotes;
      lastContent = null;
      continue;
    }

    lastContent = content;
    data = result.cleaned;
    let fatal = result.errors.slice();
    let flagged = result.dropped.slice();
    rounds.push({ stage: 'gen', round, fatal, flagged: flagged.map(f => ({ w: f.w, why: f.why })) });
    emit({ type: 'checked', stage: 'gen', round, ok: !fatal.length && !flagged.length, fatal, flagged });

    /* --- 局部问题：定向修复（好数据不动） --- */
    if (!fatal.length && flagged.length) {
      while (flagged.length && stats.repairs < B.repairs) {
        stats.repairs += 1;
        emit({ type: 'round', stage: 'repair', round: stats.repairs });
        try {
          const repContent = await call(genCfg, buildRepairPrompt(word, flagged), 'repair');
          const items = parseRepairItems(repContent);
          const fixByW = new Map();
          for (const it of items) {
            const w = typeof it.w === 'string' ? it.w.trim().toLowerCase() : '';
            if (w) fixByW.set(w, it);
          }
          const merged = data.family.slice();
          for (const fl of flagged) {
            const key = String(fl.w || '').trim().toLowerCase();
            const fix = key ? fixByW.get(key) : null;
            if (fix) merged.push(fix); // 修复输出省略该条 = 模型主动放弃，接受缺失
          }
          const again = validateWordExt({ zh: data.zh, family: merged, etymology: data.etymology }, word.k);
          data = again.cleaned;
          fatal = again.errors;
          flagged = again.dropped;
          rounds.push({ stage: 'repair', round: stats.repairs, still: flagged.map(f => ({ w: f.w, why: f.why })) });
          emit({ type: 'checked', stage: 'repair', round: stats.repairs, ok: !fatal.length && !flagged.length, fatal, flagged });
        } catch (err) {
          noteNetwork(err);
          rounds.push({ stage: 'repair', round: stats.repairs, error: err.message });
          break; // 修复轮自身失败 → 降级为整词重新生成
        }
      }
    }

    /* --- 本地仍不合格 → 带清单整词重生成 --- */
    if (fatal.length || flagged.length) {
      lastNotes = [
        ...fatal.map((f) => {
          const s = String(f);
          // 只说"含 URL"模型不知道怎么改，会把示范网址原样塞回来（dot 连败 3 轮的教训）
          if (/URL \/ Markdown 链接/.test(s)) {
            return `${s}：删掉所有真实网址、www 字样与 Markdown 链接，网络义项的示范改用中文占位（如"某知名词典网站"）`;
          }
          return s;
        }),
        ...flagged.map(f => `${f.w || '?'}：${f.why}`),
      ];
      feedback = lastNotes;
      continue;
    }

    /* --- 本地合格 --- */
    if (skipVerify) {
      emit({ type: 'done', ok: true, data, stats, rounds });
      return { ok: true, data, stats, rounds };
    }

    /* --- 背靠背核查 --- */
    stats.verifyRounds += 1;
    emit({ type: 'round', stage: 'verify', round: stats.verifyRounds });
    try {
      const vContent = await call(verifyCfg, buildVerifyPrompt(word, data), 'verify');
      const verdict = parseVerifyVerdict(vContent);
      rounds.push({ stage: 'verify', round: stats.verifyRounds, pass: verdict.pass, issues: verdict.issues });
      emit({ type: 'verdict', round: stats.verifyRounds, pass: verdict.pass, issues: verdict.issues });
      if (verdict.pass) {
        emit({ type: 'done', ok: true, data, stats, rounds });
        return { ok: true, data, stats, rounds };
      }
      verifyIssues = verdict.issues;
      if (stats.verifyRounds >= B.verifyRounds) break; // 核查预算尽 → 人工清单
      lastNotes = verdict.issues.map(i => `${i.field}: ${i.problem}`);
      feedback = lastNotes;
      continue;
    } catch (err) {
      noteNetwork(err);
      rounds.push({ stage: 'verify', round: stats.verifyRounds, error: err.message });
      lastNotes = [`核查调用失败：${err.message}`];
      feedback = lastNotes;
      continue; // 由 gen 预算兜底，不会死循环
    }
  }

  const error = verifyIssues.length
    ? `核查不通过：${verifyIssues.map(i => `${i.field}: ${i.problem}`).join('；')}`
    : lastNotes.length
      ? `多轮修复仍不合格：${lastNotes.join('；')}`
      : '管线预算用尽';
  emit({ type: 'done', ok: false, error, stats, rounds });
  return { ok: false, error, stats, rounds, verifyIssues };
}
