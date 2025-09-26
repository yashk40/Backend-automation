// app.js — JSON API backend for albums/media with Puppeteer page pool + robust Express ordering

'use strict';

const express = require('express');
const os = require('os');
const puppeteer = require('puppeteer');

// ---------- Config ----------
const PORT = process.env.PORT || 3000;
const MAX_PAGES = Math.max(1, Math.min(4, Number(process.env.MAX_PAGES) || Math.max(1, Math.min(4, os.cpus().length))));
const QUEUE_LIMIT = Number(process.env.QUEUE_LIMIT || 50); // backpressure
const LAUNCH_TIMEOUT_MS = Number(process.env.LAUNCH_TIMEOUT_MS || 0); // 0 = disable to avoid WS race on cold boot
const NAV_TIMEOUT_MS = Number(process.env.NAV_TIMEOUT_MS || 60000);
const REQ_BUDGET_MS = Number(process.env.REQ_BUDGET_MS || 90000);

// Prefer bundled Chromium; set PUPPETEER_EXECUTABLE_PATH to force system Chrome if needed
const EXECUTABLE_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;

// Chrome flags suitable for containers; avoid --single-process
const CHROME_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--no-zygote',
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-extensions',
  '--mute-audio',
  '--disable-features=Translate,BackForwardCache,MediaRouter,OptimizationHints'
];

// ---------- Browser singleton + page pool ----------
let browserPromise;
let idlePages = [];
const waiters = [];

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: true,
      executablePath: EXECUTABLE_PATH,
      args: CHROME_ARGS,
      timeout: LAUNCH_TIMEOUT_MS,
      dumpio: true
    });
    const browser = await browserPromise;

    browser.on('disconnected', () => {
      // Reset so a new one can be launched on next demand
      browserPromise = undefined;
      idlePages = [];
      // Wake up waiters with errors
      while (waiters.length) {
        const { reject } = waiters.shift();
        reject(new Error('Browser disconnected'));
      }
    });
  }
  return browserPromise;
}

async function createPooledPage(browser) {
  const page = await browser.newPage();
  // Lightweight interception to save CPU/network; keep images for thumbnails
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const rt = req.resourceType();
    if (rt === 'font') req.abort();
    else req.continue();
  });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36');
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  await page.setViewport({ width: 1280, height: 900 });
  return page;
}

async function initPool() {
  const browser = await getBrowser();
  while (idlePages.length < MAX_PAGES) {
    idlePages.push(await createPooledPage(browser));
  }
}

async function acquirePage() {
  if (idlePages.length) return idlePages.pop();
  if (waiters.length >= QUEUE_LIMIT) {
    const err = new Error('QUEUE_SATURATED');
    err.code = 429;
    throw err;
  }
  return await new Promise((resolve, reject) => waiters.push({ resolve, reject }));
}

function releasePage(page) {
  if (!page || page.isClosed()) return;
  if (waiters.length) {
    const { resolve } = waiters.shift();
    resolve(page);
  } else {
    idlePages.push(page);
  }
}

async function recyclePage(page) {
  // Try to reset page to a clean state; if fails, replace
  try {
    await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {});
    releasePage(page);
  } catch {
    try { await page.close(); } catch {}
    try {
      const browser = await getBrowser();
      const fresh = await createPooledPage(browser);
      releasePage(fresh);
    } catch {}
  }
}

async function withPage(fn, budgetMs = REQ_BUDGET_MS) {
  const page = await acquirePage();
  const killer = setTimeout(() => {
    try { page.close(); } catch {}
  }, budgetMs);
  try {
    return await fn(page);
  } finally {
    clearTimeout(killer);
    await recyclePage(page);
  }
}

async function closeBrowser() {
  try {
    const b = await browserPromise;
    await b?.close();
  } catch {}
}

// ---------- Scrapers using pooled pages ----------
async function scrapeHotPicAll(page, pageNum = 1) {
  page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
  const url = pageNum === 1 ? 'https://hotpic.one/nsfw/' : `https://hotpic.one/nsfw/${pageNum}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });

  const anchorSelector = 'a[data-zoom="false"][data-autofit="false"][data-preload="true"][data-download="true"][data-controls="false"][href^="/album/"]';
  await page.waitForSelector(anchorSelector, { timeout: NAV_TIMEOUT_MS });

  const items = await page.evaluate((sel) => {
    const anchors = Array.from(document.querySelectorAll(sel));
    const origin = location.origin;
    const absolutize = (url) => { try { return new URL(url, origin).toString(); } catch { return url || ''; } };
    return anchors.map(a => {
      const href = absolutize(a.getAttribute('href') || '');
      const img = a.querySelector('img.img-fluid') || a.querySelector('img');
      const thumb = absolutize(img ? (img.getAttribute('data-src') || img.getAttribute('src') || '') : '');
      const title = a.getAttribute('data-title') || a.getAttribute('title') || (img ? img.getAttribute('alt') : '') || '';
      return href ? { href, thumb, title } : null;
    }).filter(Boolean);
  }, anchorSelector);

  if (!items || items.length === 0) throw new Error('NO_ALBUMS');
  return items;
}

async function scrapeAlbum(page, url) {
  page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });

  const primarySel = '.hotgrid .hotplay a.spotlight';
  try {
    await page.waitForSelector(primarySel, { timeout: NAV_TIMEOUT_MS, visible: true });
  } catch {
    // Trigger lazy-load via scroll
    await page.evaluate(async () => {
      await new Promise((resolve) => {
        let y = 0;
        const step = () => {
          y += 900;
          window.scrollTo(0, y);
          if (y < document.body.scrollHeight + 1200) setTimeout(step, 150);
          else setTimeout(resolve, 500);
        };
        step();
      });
    });
    await page.waitForSelector(primarySel, { timeout: Math.min(30000, NAV_TIMEOUT_MS) });
  }

  const mediaItems = await page.evaluate(() => {
    const absolutize = (u) => { try { return new URL(u, location.origin).toString(); } catch { return u || ''; } };
    const anchors = Array.from(document.querySelectorAll('.hotgrid .hotplay a.spotlight'));
    return anchors.map(a => {
      const mediaType = (a.getAttribute('data-media') || '').toLowerCase();
      const title = a.getAttribute('title') || a.getAttribute('data-title') || '';
      const hrefAttr = a.getAttribute('href') || '';
      const href = absolutize(hrefAttr);
      const srcMp4Attr = a.getAttribute('data-src-mp4') || '';
      const srcMp4 = absolutize(srcMp4Attr);
      const poster = absolutize(a.getAttribute('data-poster') || '');
      const isVideo = mediaType === 'video' || /\.mp4(\?|$)/i.test(srcMp4Attr) || /\.mp4(\?|$)/i.test(hrefAttr);
      if (isVideo) return { kind: 'video', src: srcMp4 || href, poster: poster || '', title };

      const dataSrcAttr = a.getAttribute('data-src') || '';
      let imgSrc = dataSrcAttr ? absolutize(dataSrcAttr) : '';
      if (!imgSrc) {
        const img = a.querySelector('img');
        if (img) imgSrc = absolutize(img.getAttribute('data-src') || img.currentSrc || img.src || '');
      }
      if (!imgSrc && href && /\.(webp|avif|jpg|jpeg|png|gif|bmp)(\?|$)/i.test(hrefAttr)) imgSrc = href;
      if (!imgSrc) {
        const bg = (getComputedStyle(a).getPropertyValue('background-image') || '').trim();
        const m = bg.match(/url\(["']?(.*?)["']?\)/i);
        if (m && m[1]) imgSrc = absolutize(m[1]);
      }
      return imgSrc ? { kind: 'image', src: imgSrc, poster: '', title } : null;
    }).filter(Boolean);
  });

  // Deduplicate
  const seen = new Set();
  return mediaItems.filter(it => {
    const key = `${it.kind}:${it.src}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------- Express app ----------
const app = express();

// Per-request timeouts
app.use((req, res, next) => {
  req.setTimeout?.(REQ_BUDGET_MS + 10000);
  res.setTimeout?.(REQ_BUDGET_MS + 10000);
  next();
});

// Health
app.get('/health', (_req, res) => res.json({ ok: true }));

// Backpressure indicator
app.get('/metrics', (_req, res) => {
  res.json({
    idlePages: idlePages.length,
    waiting: waiters.length,
    maxPages: MAX_PAGES
  });
});

// APIs
app.get('/api/home', async (req, res, next) => {
  try {
    const pageNum = parseInt(req.query.page, 10) || 1;
    const items = await withPage((page) => scrapeHotPicAll(page, pageNum));
    res.json({ count: items.length, items, page: pageNum });
  } catch (e) {
    if (e?.code === 429 || String(e.message).includes('QUEUE_SATURATED')) {
      return res.status(429).json({ error: 'BUSY', message: 'Too many concurrent requests' });
    }
    if (String(e.message).includes('NO_ALBUMS')) {
      return res.status(404).json({ error: 'NO_ALBUMS' });
    }
    next(e);
  }
});

app.get('/api/album', async (req, res, next) => {
  try {
    const albumUrl = req.query.u;
    if (!albumUrl) return res.status(400).json({ error: 'MISSING_URL' });
    // validate URL
    new URL(albumUrl);
    const items = await withPage((page) => scrapeAlbum(page, albumUrl));
    if (!items.length) return res.status(404).json({ error: 'NO_MEDIA' });
    res.json({ count: items.length, items });
  } catch (e) {
    if (e?.code === 429 || String(e.message).includes('QUEUE_SATURATED')) {
      return res.status(429).json({ error: 'BUSY', message: 'Too many concurrent requests' });
    }
    next(e);
  }
});

// 404
app.use((_req, res) => res.status(404).json({ error: 'NOT_FOUND' }));

// Error handler LAST
app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'INTERNAL', message: String(err.message || err) });
});

// Startup
(async () => {
  try {
    await initPool(); // warm Chrome + pages
    app.listen(PORT, () => console.log(`Listening on http://localhost:${PORT}`));
  } catch (e) {
    console.error('Failed to initialize pool:', e);
    process.exit(1);
  }
})();

// Graceful shutdown
process.on('SIGTERM', closeBrowser);
process.on('SIGINT', closeBrowser);
