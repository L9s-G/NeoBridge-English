/**
 * 应用外壳：把各模块接到一起。
 *
 * 职责只有三块 ——
 *   1. 打开 IndexedDB，恢复已下载的词包（坏包自动清理）
 *   2. 首页：词包管理、进度展示
 *   3. 点"开始" → 交给 ui/session.js 跑一整轮
 */

import { lastDays } from './core/day.js';
import { searchWords } from './core/dict.js';
import { withParams } from './core/params.js';
import { coverageOf } from './core/progress.js';
import { isWrongWord } from './core/pools.js';
import { downloadPack, removePack, restorePacks, setActivePackId } from './db/importer.js';
import { loadExt } from './db/ext-loader.js';
import { getActivePackId, loadDaily, loadProgress, openStore } from './db/stores.js';
import { audioNamesOf, countCached, downloadAudio, playAudio } from './ui/audio-download.js';
import { renderDictList, renderWeek, renderWrongList } from './ui/lists.js';
import { openSession } from './ui/session.js';
import { detailView, h, replaceChildren } from './ui/views.js';

const BUNDLED_BASE = './data/';
const params = withParams();

/**
 * 入口信号：legacy.html 不带 manifest link —— 旧版入口不注册 Service Worker、
 * 不显示「下载全部发音」卡（发音只在线播）。现代 index.html 带 manifest → 走 PWA。
 */
const IS_LEGACY = !document.querySelector('link[rel="manifest"]');

const $ = id => document.getElementById(id);

/**
 * 标题栏小电视图标兼状态提示：潮流版灰（hover 亮，点按 → legacy.html），
 * 经典版亮（hover 灰，点按 → index.html，href 已由 build:legacy 改写）。
 * 模块脚本在 body 末尾执行，DOM 已就绪。
 */
const modeSwitch = document.querySelector('.classic-link');
if (modeSwitch) {
  modeSwitch.classList.toggle('on', IS_LEGACY);
  modeSwitch.title = IS_LEGACY ? '当前：经典版 · 点按切回潮流版' : '当前：潮流版 · 点按切换经典版';
  modeSwitch.setAttribute('aria-label', modeSwitch.title);
}

/** 初始化/下载失败统一落这里：页面底部的 #detail（默认隐藏） */
function showError(prefix, err) {
  console.error(err);
  const el = $('detail');
  el.hidden = false;
  el.textContent = `${prefix}${err?.stack || err?.message || String(err)}`;
}

/** 状态栏（设置区）：进度类文案；失败走 showError */
function setStatus(text, isError = false) {
  const el = $('status');
  el.textContent = text;
  el.classList.toggle('error', isError);
}

function fmtBytes(n) {
  return n >= 1024 * 1024
    ? `${(n / 1024 / 1024).toFixed(2)} MB`
    : `${Math.round(n / 1024)} KB`;
}

/* ---------------- 渲染 ---------------- */

let db = null;
let view = { packs: [], activeId: null, payload: null, progress: {}, ext: null };
let audioNames = [];

function renderPacks() {
  $('pack-card').hidden = false;
  const list = $('pack-list');
  replaceChildren(list);

  if (!view.packs.length) {
    const li = document.createElement('li');
    li.textContent = '本地还没有词包，点下面的按钮下载。';
    list.append(li);
    return;
  }

  for (const { record } of view.packs) {
    const active = record.id === view.activeId;
    const li = document.createElement('li');

    const name = document.createElement('div');
    name.className = 'pack-name';
    name.append(`${record.packId} v${record.version}`);
    const meta = document.createElement('small');
    meta.textContent =
      `${record.levels.join('/')} · ${record.wordCount} 词 · ${record.senseCount} 义项 · ` +
      `${fmtBytes(record.bytes)} · sha ${record.sha256.slice(0, 12)}`;
    name.append(meta);
    li.append(name);

    const badge = document.createElement('span');
    badge.className = 'badge' + (active ? ' on' : '');
    badge.textContent = active ? '当前' : '';
    li.append(badge);

    if (!active) {
      const use = document.createElement('button');
      use.textContent = '使用';
      use.onclick = async () => {
        await setActivePackId(db, record.id);
        await refresh();
      };
      li.append(use);
    }

    const del = document.createElement('button');
    del.className = 'danger';
    del.textContent = '删除';
    del.title = '删除本地记录，重新下载即可更新';
    del.onclick = async () => {
      if (!confirm(`删除词包 ${record.packId} v${record.version}？\n（进度不会被清除）`)) return;
      await removePack(db, record.id);
      await refresh();
    };
    li.append(del);

    list.append(li);
  }
}

function renderStats() {
  const card = $('stat-card');
  if (!view.payload) { card.hidden = true; return; }
  card.hidden = false;

  const words = view.payload.words;
  const answered = words.filter(w => view.progress[w.k]?.lastResult != null).length;
  const coverage = coverageOf(view.progress, words);
  const trained = Object.keys(view.progress).length;

  $('stat-list').innerHTML = '';
  const rows = [
    ['词包', `${view.payload.packId} v${view.payload.version}`],
    ['词/义', `${words.length} / ${view.payload.senseCount}`],
    ['刷过', `${answered}（${(coverage * 100).toFixed(1)}%）`],
    ['总进度', `${trained}（含其它包）`],
  ];
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    $('stat-list').append(dt, dd);
  }
  $('meter-fill').style.width = `${coverage * 100}%`;
}

/**
 * 发音卡：清单来自当前词包，进度条 = Cache Storage 里已经存下的比例。
 * 老词包（v1）没有 a 字段 → 必须显眼地报错并给出下一步，不能只留一行灰字。
 */
async function renderAudio() {
  const card = $('audio-card');
  const hint = $('audio-hint');
  const btn = $('btn-audio');
  // 旧版入口没有 Service Worker，发音只在线播 —— 下载卡整块隐藏，按钮不可达
  if (IS_LEGACY || !view.payload) { card.hidden = true; return; }
  card.hidden = false;
  audioNames = audioNamesOf(view.payload);

  if (!audioNames.length) {
    btn.disabled = true;
    $('audio-fill').style.width = '0';
    hint.classList.add('error');
    hint.textContent =
      `当前词包 ${view.payload.packId} v${view.payload.version} 不含发音数据（发音从 v2 起才内置）。` +
      '请在上面「词包」里点「删除」，再点「下载内置词包」换成最新版。';
    setStatus(`词包 ${view.payload.packId} v${view.payload.version} 不含发音 —— 删除后重新下载`, true);
    return;
  }

  btn.disabled = false;
  hint.classList.remove('error');
  const have = await countCached(audioNames);
  hint.textContent = `${audioNames.length} 个发音文件 · 已下载 ${have}`;
  $('audio-fill').style.width = `${(have / audioNames.length) * 100}%`;
}

/** 首页两个清单：最近 7 天复习卡 + 错词（最久没练的排最前） */
async function renderLists() {
  const has = !!view.payload;
  $('week-card').hidden = !has;
  $('wrong-card').hidden = !has;
  if (!has) return;

  const byKey = new Map(view.payload.words.map(w => [w.k, w]));
  const days = lastDays(7);
  const rows = await loadDaily(db, days[0], days[days.length - 1]);
  renderWeek($('week-card'), rows, byKey);

  const wrongWords = view.payload.words
    .filter(w => isWrongWord(view.progress[w.k], params));
  const entries = wrongWords
    .map(w => ({ k: w.k, lastWrongAt: view.progress[w.k].lastWrongAt ?? 0 }))
    .sort((a, b) => a.lastWrongAt - b.lastWrongAt);

  // 「复练全部」按名单顺序（最久没练在最上）交出去；抽题顺序仍由调度器决定
  const order = entries.map(e => byKey.get(e.k));
  renderWrongList($('wrong-card'), entries, byKey, () => startSession(order.length, order));
}

/* ---------------- 词典 ---------------- */

const DICT_LIMIT = 50;

/** 详情开着时记 wordKey（换包刷新时按 k 重新解析，词没了就自纠回列表） */
let dictDetailKey = null;

/** 按输入框当前内容重画词典；查询串原样保留（刷新不会清掉用户正在打的字） */
function drawDictResults() {
  const list = $('dict-list');
  const hint = $('dict-hint');
  if (!view.payload) return;

  const q = $('dict-q').value;
  if (!q.trim()) {
    replaceChildren(list);
    hint.textContent = `${view.payload.words.length} 词 · 输入英文开始查询（大小写不敏感，含短语）`;
    return;
  }

  const hits = searchWords(view.payload.words, q);
  if (!hits.length) {
    replaceChildren(list);
    hint.textContent = `没有匹配「${q.trim()}」的词`;
    return;
  }

  hint.textContent = hits.length > DICT_LIMIT
    ? `${hits.length} 个匹配 · 显示前 ${DICT_LIMIT}`
    : `${hits.length} 个匹配`;
  renderDictList(list, hits.slice(0, DICT_LIMIT), openDictDetail);
}

/**
 * 单词卡详情（只读）：正面 + 背面（义项 + 扩展区）+ 返回按钮。
 * key 为空 / 词已不在当前词包 → 自纠关详情、回列表，不报错。
 */
function renderDictDetail() {
  const card = $('dict-detail');
  const word = view.payload && view.payload.words.find(w => w.k === dictDetailKey);
  if (!word) {
    dictDetailKey = null;
    card.hidden = true;
    $('dict-card').hidden = !view.payload;
    if (view.payload) drawDictResults();
    return;
  }
  replaceChildren(card,
    h('button', { class: 'btn ghost dict-back', onclick: closeDictDetail }, '← 返回列表'),
    detailView(
      word,
      view.payload.baseUrl,
      view.ext ? view.ext.map.get(word.k) : null,
      playAudio,
    ),
  );
  card.hidden = false;
  $('dict-card').hidden = true;
}

function openDictDetail(word) {
  dictDetailKey = word.k;
  renderDictDetail();
  window.scrollTo(0, 0);
}

function closeDictDetail() {
  dictDetailKey = null;
  renderDictDetail();
}

function renderDict() {
  // 详情开着时不动列表（只重画详情或自纠关闭），避免刷新把画面切回去
  if (dictDetailKey) { renderDictDetail(); return; }
  $('dict-detail').hidden = true;
  $('dict-card').hidden = !view.payload;
  if (view.payload) drawDictResults();
}

/* ---------------- 主流程 ---------------- */

/** 有词包才能开一轮 */
function renderStart() {
  $('start-card').hidden = !view.payload;
}

function showHome(show) {
  $('home').hidden = !show;
  $('session-card').hidden = show;
}

/** 底部导航：一次只显示一个分区（复习 / 进度 / 词包） */
function showPane(name) {
  document.querySelectorAll('#tabs .tab').forEach(btn => {
    btn.classList.toggle('on', btn.dataset.tab === name);
  });
  document.querySelectorAll('.pane').forEach(pane => {
    pane.hidden = pane.id !== `pane-${name}`;
  });
}

/**
 * 开一轮答题。words 默认整包；传子集即"只练这一批"（如强化记忆的错词复练）。
 * states 永远传全量进度 —— 调度要看完整的掌握度，不只是这批词。
 */
function startSession(size, words) {
  if (!view.payload) return;
  const host = $('session-card');
  showHome(false);

  openSession({
    db,
    words: words || view.payload.words,
    baseUrl: view.payload.baseUrl,
    states: view.progress,
    extMap: view.ext ? view.ext.map : null,
    size,
    host,
    onExit: async () => {
      // 先刷完再切回首页，避免首页短暂显示上一轮的旧数字
      await refresh();
      showHome(true);
    },
  });
}

/** 重读数据库并重画；状态栏一律由这里收尾，避免显示过期文本 */
async function refresh() {
  const { packs, removed } = await restorePacks(db);
  if (removed.length) console.warn('已清理损坏的词包：', removed);

  view.packs = packs;
  view.activeId = await getActivePackId(db);

  const active = packs.find(p => p.record.id === view.activeId) || packs[0] || null;
  view.payload = active ? active.payload : null;
  view.progress = await loadProgress(db);

  renderStart();
  renderPacks();
  renderStats();
  renderDict();
  await renderLists();

  setStatus(
    packs.length ? `就绪 · ${packs.length} 个词包` : '没有可用词包，去设置区下载',
    packs.length === 0,
  );
  // 放最后：词包不含发音时 renderAudio 要能把这行状态改成红字
  await renderAudio();
}

async function boot() {
  try {
    if (!IS_LEGACY && 'serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js')
        .catch(err => console.warn('Service Worker 注册失败', err));
    }

    setStatus('正在打开本地数据库…');
    // 扩展数据与 IDB/词包恢复并行拉取（loadExt 全程失败兜底 null，不阻塞初始化）
    const extPromise = loadExt();
    db = await openStore();

    setStatus('正在恢复已下载的词包…');
    const existing = await restorePacks(db);
    if (!existing.packs.length) {
      setStatus('本地没有词包，正在下载内置词包…');
      await downloadPack(db, { baseUrl: BUNDLED_BASE });
    }

    view.ext = await extPromise;
    await refresh();
  } catch (err) {
    showError('初始化失败：', err);
    setStatus(`初始化失败：${err.message}`, true);
  }
}

$('btn-download').onclick = async () => {
  const btn = $('btn-download');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '下载中…';
  try {
    await downloadPack(db, { baseUrl: BUNDLED_BASE });
    await refresh();
    btn.textContent = '已下载';
    setTimeout(() => { btn.textContent = label; }, 1500);
  } catch (err) {
    btn.textContent = label;
    showError('下载失败：', err);
    setStatus(`词包下载失败：${err.message}`, true);
  } finally {
    btn.disabled = false;
  }
};

$('btn-audio').onclick = async () => {
  const btn = $('btn-audio');
  if (!audioNames.length) return;
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = '下载中…';
  try {
    const state = await downloadAudio(audioNames, {
      concurrency: 6,
      onProgress: s => {
        btn.textContent = `下载中… ${s.done}/${s.total}`;
        $('audio-fill').style.width = `${(s.done / s.total) * 100}%`;
        $('audio-hint').textContent =
          `已下载 ${s.skipped + s.ok} / ${s.total}${s.failed.length ? `（失败 ${s.failed.length}）` : ''}`;
      },
    });
    const have = await countCached(audioNames);
    $('audio-hint').textContent = state.failed.length
      ? `已下载 ${have} / ${state.total}，失败 ${state.failed.length} 个 —— 再点一次会跳过已下载的`
      : `全部就绪：${have} / ${state.total} 个发音已可离线播放`;
    btn.textContent = state.failed.length ? '有失败，重试' : '已就绪';
    setStatus(state.failed.length
      ? `发音下载未完成：失败 ${state.failed.length} 个`
      : `发音已下载 ${have} 个 · ${fmtBytes(state.bytes)}`);
  } catch (err) {
    btn.textContent = label;
    showError('发音下载失败：', err);
    setStatus(`发音下载失败：${err.message}`, true);
  } finally {
    btn.disabled = false;
    setTimeout(() => { if (btn.textContent !== label) btn.textContent = '下载全部发音'; }, 4000);
  }
};

$('tabs').addEventListener('click', e => {
  const btn = e.target.closest('.tab');
  if (btn) showPane(btn.dataset.tab);
});

$('dict-q').addEventListener('input', drawDictResults);

$('btn-start').onclick = () => {
  // 题数只有一个来源：HTML 的 <select id="size">（selected 那项即默认）。
  // 这里只做"值非法就退回第一项"的兜底，不再硬编码第二个默认数字。
  const sel = $('size');
  const size = Number(sel.value) || Number(sel.options[0] && sel.options[0].value) || 0;
  if (size > 0) startSession(size);
};

boot();
