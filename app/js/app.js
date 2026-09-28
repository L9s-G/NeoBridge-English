/**
 * 应用外壳：把各模块接到一起。
 *
 * 职责只有三块 ——
 *   1. 打开 IndexedDB，恢复已下载的词包（坏包自动清理）
 *   2. 首页：词包管理、进度展示
 *   3. 点"开始" → 交给 ui/session.js 跑一整轮
 */

import { lastDays } from './core/day.js';
import { withParams } from './core/params.js';
import { coverageOf } from './core/progress.js';
import { isWrongWord } from './core/pools.js';
import { downloadPack, removePack, restorePacks, setActivePackId } from './db/importer.js';
import { getActivePackId, loadDaily, loadProgress, openStore } from './db/stores.js';
import { audioNamesOf, countCached, downloadAudio } from './ui/audio-download.js';
import { renderWeek, renderWrongList } from './ui/lists.js';
import { openSession } from './ui/session.js';
import { replaceChildren } from './ui/views.js';

const BUNDLED_BASE = './data/';
const params = withParams();

/**
 * 入口信号：legacy.html 不带 manifest link —— 旧版入口不注册 Service Worker、
 * 不显示「下载全部发音」卡（发音只在线播）。现代 index.html 带 manifest → 走 PWA。
 */
const IS_LEGACY = !document.querySelector('link[rel="manifest"]');

const $ = id => document.getElementById(id);

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
let view = { packs: [], activeId: null, payload: null, progress: {} };
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

  const wrongs = view.payload.words
    .filter(w => isWrongWord(view.progress[w.k], params))
    .map(w => ({ k: w.k, lastWrongAt: view.progress[w.k].lastWrongAt ?? 0 }))
    .sort((a, b) => a.lastWrongAt - b.lastWrongAt);

  renderWrongList($('wrong-card'), wrongs, byKey);
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

function startSession(size) {
  if (!view.payload) return;
  const host = $('session-card');
  showHome(false);

  openSession({
    db,
    words: view.payload.words,
    baseUrl: view.payload.baseUrl,
    states: view.progress,
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
    db = await openStore();

    setStatus('正在恢复已下载的词包…');
    const existing = await restorePacks(db);
    if (!existing.packs.length) {
      setStatus('本地没有词包，正在下载内置词包…');
      await downloadPack(db, { baseUrl: BUNDLED_BASE });
    }

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

$('btn-start').onclick = () => {
  const size = Number($('size').value) || 20;
  startSession(size);
};

boot();
