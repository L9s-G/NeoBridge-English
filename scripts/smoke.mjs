import { chromium } from 'playwright-core';

// 默认跑新版入口；SMOKE_PATH=legacy.html 跑旧版入口（iOS 12 用的那个）
const PAGE = '/' + String(process.env.SMOKE_PATH || '').replace(/^\/+/, '');
const BASE = 'http://localhost:1080' + PAGE;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('dialog', async d => { console.log('DIALOG:', d.message().slice(0, 80)); await d.dismiss(); });

// 旧版入口的发音卡整块隐藏（只在线播），textContent 会拿到初始占位文案 —— 显式标注
const hint = async () => (await page.$eval('#audio-card', el => el.hidden))
  ? '(audio-card hidden)'
  : (await page.textContent('#audio-hint')).trim();
const packs = async () => (await page.textContent('#pack-list')).replace(/\s+/g, ' ').trim();

try {
  console.log('[entry]    ', BASE);
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(2500);
  console.log('[boot]     title =', await page.title());
  console.log('[boot]     sw registrations =',
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length));
  console.log('[boot]     audio-card hidden =', await page.$eval('#audio-card', el => el.hidden));

  await page.click('#tabs .tab[data-tab="packs"]');
  console.log('[boot]     hint =', await hint());
  console.log('[boot]     packs =', await packs());

  // 1) 正常路径：点「下载内置词包」
  await page.click('#btn-download');
  await page.waitForTimeout(3000);
  console.log('[after dl] hint =', await hint());
  console.log('[after dl] packs =', await packs());
  console.log('[after dl] status =', (await page.textContent('#status')).trim());

  // 词典 tab：前缀查询有命中 → 点进单词卡详情 → 返回列表；无匹配/清空给正确提示
  await page.click('#tabs .tab[data-tab="dict"]');
  await page.fill('#dict-q', 'abil');
  console.log('[dict]     hint =', (await page.textContent('#dict-hint')).trim());
  console.log('[dict]     top3 =', await page.evaluate(() =>
    [...document.querySelectorAll('#dict-list .dict-word')].slice(0, 3).map(el => el.textContent)));

  await page.click('#dict-list li');
  await page.waitForTimeout(300);
  console.log('[dict]     detail =', await page.evaluate(() => ({
    listHidden: document.getElementById('dict-card').hidden,
    back: !!document.querySelector('#dict-detail .dict-back'),
    word: (document.querySelector('#dict-detail .q-word') || {}).textContent || null,
    senses: document.querySelectorAll('#dict-detail .sense').length,
    ext: !!document.querySelector('#dict-detail .q-ext'),
  })));
  await page.click('#dict-detail .dict-back');
  await page.waitForTimeout(200);
  console.log('[dict]     back =', await page.evaluate(() => ({
    detailHidden: document.getElementById('dict-detail').hidden,
    listShown: !document.getElementById('dict-card').hidden,
    n: document.querySelectorAll('#dict-list li').length,
  })));

  await page.fill('#dict-q', 'zzzqqq');
  console.log('[dict]     miss =', (await page.textContent('#dict-hint')).trim());
  await page.fill('#dict-q', '');
  console.log('[dict]     empty =', (await page.textContent('#dict-hint')).trim());

  // 2) 模拟"老词包"：往 IndexedDB 塞一个 v1（没有 a 字段）并激活
  const seeded = await page.evaluate(async () => {
    const stores = await import('/js/db/stores.js');
    const importer = await import('/js/db/importer.js');
    const db = await stores.openStore();
    const manifest = await (await fetch('./data/manifest.json')).json();
    const text = await (await fetch('./data/' + manifest.file)).text();
    const v1 = JSON.parse(text);
    v1.version = 1;
    for (const w of v1.words) for (const s of w.senses) delete s.a;
    const bytes = new TextEncoder().encode(JSON.stringify(v1));
    const record = {
      id: 'evp-uk-b1b2@1', packId: v1.packId, version: 1, schemaVersion: 1,
      levels: v1.levels, baseUrl: v1.baseUrl, wordCount: v1.wordCount,
      senseCount: v1.senseCount, bytes: bytes.byteLength,
      sha256: await importer.sha256Hex(bytes), importedAt: Date.now(), data: bytes,
    };
    await stores.putPack(db, record);
    await stores.setActivePackId(db, record.id);
    return { bytes: bytes.byteLength, sha: record.sha256.slice(0, 12) };
  });
  console.log('[seeded v1]', seeded);

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  await page.click('#tabs .tab[data-tab="packs"]');
  console.log('[v1 active] hint =', await hint());
  console.log('[v1 active] hint class =', await page.$eval('#audio-hint', el => el.className));
  console.log('[v1 active] btn-audio disabled =', await page.$eval('#btn-audio', el => el.disabled));
  console.log('[v1 active] status =', (await page.textContent('#status')).trim());
  console.log('[v1 active] packs =', await packs());

  // 卡片正面：老词包下喇叭应该是 YouGlish 外链
  await page.click('#tabs .tab[data-tab="review"]');
  await page.click('#btn-start');
  await page.waitForTimeout(800);
  console.log('[v1 active] card =', await page.$eval('.q-front', el => el.querySelector('.q-word').textContent));
  console.log('[v1 active] bell =', await page.$eval('.q-sound .q-bell', el => `${el.tagName} title=${el.getAttribute('title')}`));

  await page.click('.session-head button');

  // 3) 这时点「下载内置词包」——用户报告的场景
  await page.click('#tabs .tab[data-tab="packs"]');
  await page.click('#btn-download');
  await page.waitForTimeout(4000);
  console.log('[re-dl]    hint =', await hint());
  console.log('[re-dl]    hint class =', await page.$eval('#audio-hint', el => el.className));
  console.log('[re-dl]    btn-audio disabled =', await page.$eval('#btn-audio', el => el.disabled));
  console.log('[re-dl]    packs =', await packs());
  console.log('[re-dl]    status =', (await page.textContent('#status')).trim());

  await page.click('#tabs .tab[data-tab="review"]');
  await page.click('#btn-start');
  await page.waitForTimeout(800);
  console.log('[re-dl]    card =', await page.$eval('.q-front', el => el.querySelector('.q-word').textContent));
  console.log('[re-dl]    bell =', await page.$eval('.q-sound .q-bell', el => `${el.tagName} title=${el.getAttribute('title')}`));

  // 卡背扩展区：默认折叠的「扩展信息」；词源块按首发策略应整块不存在（短语卡无扩展数据则整块缺席）
  await page.click('.q-actions .btn');
  await page.waitForTimeout(300);
  console.log('[re-dl]    ext =', await page.evaluate(() => {
    const word = document.querySelector('.q-word').textContent;
    const d = document.querySelector('.q-ext');
    if (!d) return { word, present: false };
    return {
      word,
      present: true,
      open: d.open,
      summary: d.querySelector('summary').textContent,
      hasZh: !!d.querySelector('.ext-zh'),
      hasOrigin: !!d.querySelector('.ext-origin'),
      hasStory: !!d.querySelector('.ext-story'),
      chips: d.querySelectorAll('.ext-chip').length,
      chip0: (d.querySelector('.ext-chip') || {}).textContent || null,
    };
  }));
  console.log('[re-dl]    ext cache =', await page.evaluate(async () => {
    try {
      const cache = await caches.open('neobridge-ext');
      const meta = await cache.match('./data/manifest-ext.json');
      const body = await cache.match('./data/ext.v1.json');
      return { meta: !!meta, bodyBytes: body ? (await body.text()).length : 0 };
    } catch (e) {
      return 'err: ' + e.message;
    }
  }));

  await page.click('.session-head button');
  await page.waitForTimeout(300);
  console.log('[re-dl]    status =', (await page.textContent('#status')).trim());

} catch (err) {
  console.log('FAILED:', err.message);
} finally {
  console.log('errors:', errors.length ? errors : 'none');
  await browser.close();
}
