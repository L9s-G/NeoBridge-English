import { chromium } from 'playwright-core';

const BASE = 'http://localhost:1080/';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('dialog', async d => { console.log('DIALOG:', d.message().slice(0, 80)); await d.dismiss(); });

const hint = async () => (await page.textContent('#audio-hint')).trim();
const packs = async () => (await page.textContent('#pack-list')).replace(/\s+/g, ' ').trim();

try {
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(2500);

  await page.click('#tabs .tab[data-tab="packs"]');
  console.log('[boot]     hint =', await hint());
  console.log('[boot]     packs =', await packs());

  // 1) 正常路径：点「下载内置词包」
  await page.click('#btn-download');
  await page.waitForTimeout(3000);
  console.log('[after dl] hint =', await hint());
  console.log('[after dl] packs =', await packs());
  console.log('[after dl] status =', (await page.textContent('#status')).trim());

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
  await page.click('.session-head button');
  await page.waitForTimeout(300);
  console.log('[re-dl]    status =', (await page.textContent('#status')).trim());

} catch (err) {
  console.log('FAILED:', err.message);
} finally {
  console.log('errors:', errors.length ? errors : 'none');
  await browser.close();
}
