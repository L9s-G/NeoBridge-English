#!/usr/bin/env node
/**
 * EVP Online (englishprofile.org) B1/B2 word scraper.
 *
 * The site is a Bubble.io SPA: request bodies are encrypted, but responses are
 * plain JSON. So we drive the UI (level filter + pagination) with a real
 * browser and harvest every `/elasticsearch/msearch` response body.
 *
 * Usage:
 *   node scripts/scrape-evp.mjs              # resume from checkpoint if present
 *   node scripts/scrape-evp.mjs --fresh      # ignore checkpoint, start over
 *   node scripts/scrape-evp.mjs --max-pages 5  # smoke test (5 pages)
 */

import { chromium } from 'playwright-core';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DATA_TYPE, LEVELS, EXPECTED_TOTAL, buildRows, loadAudioMap, sortRows, writeDb, report,
} from './evp-lib.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = join(ROOT, 'data');
const RAW_DIR = join(DATA_DIR, 'raw');
const CHECKPOINT = join(RAW_DIR, 'checkpoint.json');
const AUDIO_FILES = join(RAW_DIR, 'audio-files.json');
const DB_PATH = join(DATA_DIR, 'evp.sqlite');

const SITE = 'https://englishprofile.org/?menu=evp-online';
const PAGE_SIZE = 20;

const args = process.argv.slice(2);
const fresh = args.includes('--fresh');
const maxPagesArg = args.indexOf('--max-pages');
const MAX_PAGES = maxPagesArg >= 0 ? Number(args[maxPagesArg + 1]) : Infinity;

mkdirSync(RAW_DIR, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitFor(fn, { timeout = 45000, interval = 400 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await fn()) return true;
    await sleep(interval);
  }
  return false;
}

function loadCheckpoint() {
  if (fresh || !existsSync(CHECKPOINT)) return null;
  try {
    const cp = JSON.parse(readFileSync(CHECKPOINT, 'utf8'));
    if (!Array.isArray(cp.records)) return null;
    console.log(`[resume] loaded checkpoint: page ${cp.page}, ${cp.records.length} records`);
    return cp;
  } catch (e) {
    console.warn('[resume] checkpoint unreadable, starting fresh:', e.message);
    return null;
  }
}

function saveCheckpoint(page, records, lookups) {
  const payload = {
    page,
    savedAt: new Date().toISOString(),
    records: [...records.values()],
    lookups: [...lookups.entries()],
  };
  writeFileSync(CHECKPOINT, JSON.stringify(payload));
}

async function main() {
  const cp = loadCheckpoint();
  const records = new Map();
  const lookups = new Map();
  let startPage = 1;

  if (cp) {
    for (const r of cp.records) records.set(r._id, r);
    for (const [k, v] of cp.lookups || []) lookups.set(k, v);
    startPage = Math.max(1, cp.page);
  }

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();

  let pending = 0;
  let parseErrors = 0;
  page.on('response', res => {
    if (!/elasticsearch\/m?search/.test(res.url())) return;
    pending += 1;
    res
      .text()
      .then(text => {
        const json = JSON.parse(text);
        for (const batch of json.responses || [json]) {
          for (const hit of (batch.hits && batch.hits.hits) || []) {
            const src = hit._source;
            if (!src || !src._type) continue;
            if (src._type === DATA_TYPE) records.set(src._id, src);
            else if (src.name_text !== undefined) lookups.set(String(src._id), src.name_text);
          }
        }
      })
      .catch(() => { parseErrors += 1; })
      .finally(() => { pending -= 1; });
  });

  console.log('[1/4] opening page...');
  await page.goto(SITE, { waitUntil: 'networkidle', timeout: 90000 });
  await page.waitForTimeout(3500);

  const foundLevels = await page.evaluate(levels => {
    const rg = [...document.querySelectorAll('.bubble-element.RepeatingGroup')]
      .find(r => /repeat\(6/.test(r.getAttribute('style') || ''));
    if (!rg) return [];
    const leaves = [...rg.querySelectorAll('*')].filter(e => e.children.length === 0);
    const clicked = [];
    for (const lv of levels) {
      const el = leaves.find(e => String(e.innerText || e.textContent || '').trim() === lv);
      if (el) { el.click(); clicked.push(lv); }
    }
    return clicked;
  }, LEVELS);
  if (foundLevels.length !== LEVELS.length) {
    throw new Error(`could not select levels ${LEVELS} (found: ${foundLevels})`);
  }
  await page.waitForTimeout(700);

  // Pin page size to 20: Bubble's "100"/"All" options trigger lazy rendering
  // and only ever materialise ~21 rows.
  await page.evaluate(() => {
    const s = [...document.querySelectorAll('select')]
      .find(x => [...x.options].some(o => o.textContent.trim() === 'All'));
    if (s && s.value !== '"20"') {
      s.value = '"20"';
      s.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });

  // Drop records harvested from the default (unfiltered) view so that the
  // progress counters below only ever count search results.
  records.clear();
  console.log(`[2/4] running search for ${LEVELS.join('+')}...`);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.innerText.trim() === 'Search');
    if (b) b.click();
  });

  const header = () => page.evaluate(() => {
    const m = document.body.innerText.match(/Results:\s*(\d+)\s*-\s*(\d+)\s*of\s*(\d+)/);
    return m ? { from: Number(m[1]), to: Number(m[2]), total: Number(m[3]) } : null;
  });

  const ok = await waitFor(async () => {
    const h = await header();
    return h && h.total > 0 && h.from === 1;
  }, { timeout: 30000 });
  if (!ok) throw new Error('search did not produce results');

  const first = await header();
  const total = first.total;
  const pages = Math.ceil(total / PAGE_SIZE);
  console.log(`      total=${total} -> ${pages} pages of ${PAGE_SIZE}`);
  if (total !== EXPECTED_TOTAL) {
    console.warn(`      ! site reports ${total}, expected ${EXPECTED_TOTAL}`);
  }

  console.log('[3/4] paginating and harvesting responses...');
  const lastPage = Math.min(pages, MAX_PAGES);
  const t0 = Date.now();

  for (let p = 1; p <= lastPage; p += 1) {
    const expected = Math.min(p * PAGE_SIZE, total);
    const got = await waitFor(async () => {
      if (pending > 0) return false;
      if (records.size < expected) return false;
      const h = await header();
      return !!h && h.from === (p - 1) * PAGE_SIZE + 1;
    }, { timeout: 60000 });

    if (!got) {
      const h = await header();
      throw new Error(
        `page ${p}: expected ${expected} records, have ${records.size}, header=${JSON.stringify(h)}`,
      );
    }

    if (p % 10 === 0 || p === lastPage) {
      saveCheckpoint(p, records, lookups);
      const secs = ((Date.now() - t0) / 1000).toFixed(0);
      console.log(
        `      page ${p}/${lastPage}  records=${records.size}/${total}  ${secs}s  (parseErr=${parseErrors})`,
      );
    }

    if (p === lastPage) break;

    await page.evaluate(() => {
      const next = [...document.querySelectorAll('button.clickable-element')]
        .find(b => (b.innerHTML || '').includes('chevron-right') && b.style.opacity !== '0.25');
      if (next) next.click();
    });

    const advanced = await waitFor(async () => {
      const h = await header();
      return !!h && h.from === p * PAGE_SIZE + 1;
    }, { timeout: 30000 });
    if (!advanced) throw new Error(`page ${p}: failed to advance to next page`);
  }

  await waitFor(() => pending === 0, { timeout: 15000 });
  saveCheckpoint(lastPage, records, lookups);

  console.log(`[4/4] harvesting done: ${records.size} raw records`);
  const { rows, offFilter } = buildRows(records, lookups);
  sortRows(rows);

  const audio = loadAudioMap(AUDIO_FILES);
  const entries = writeDb(rows, DB_PATH, { audio });
  const clean = report(rows, offFilter, audio);

  await browser.close();
  console.log(`SQLite written: ${DB_PATH}  (${entries.length} entries in evp_entry)`);
  if (!clean) {
    console.warn(`Row count differs from expected ${EXPECTED_TOTAL} — inspect data/raw/checkpoint.json`);
    process.exitCode = 2;
  }
}

main().catch(err => {
  console.error('\nFAILED:', err.message);
  console.error('Re-run the same command to resume from the last checkpoint.');
  process.exit(1);
});
