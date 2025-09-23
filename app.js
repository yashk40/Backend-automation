// app.js — Optimized JSON API backend for albums/media with Puppeteer + Express
const express = require('express');
const puppeteer = require('puppeteer');
const { URL } = require('url');

// ----- Lightweight LRU Cache -----
class LRUCache {
  constructor(maxSize) {
    this.maxSize = maxSize;
    this.cache = new Map();
  }
  get(key) {
    if (!this.cache.has(key)) return null;
    const value = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }
  set(key, value) {
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, value);
  }
}
const cache = new LRUCache(10); // Small cache to fit in 200 MB

// ----- Puppeteer config -----
const CHROME_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome';
const CHROME_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--no-zygote',
  '--single-process',
  '--disable-background-networking',
  '--disable-extensions',
  '--disable-sync',
  '--disable-translate',
  '--no-first-run',
  '--disable-background-timer-throttling',
  '--disable-client-side-phishing-detection',
  '--disable-default-apps',
  '--disable-hang-monitor',
  '--disable-prompt-on-repost',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-ipc-flooding-protection',
  '--enable-low-end-device-mode',
  '--js-flags=--expose-gc' // Enable manual GC
];

let browser = null;
async function getBrowser() {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: CHROME_PATH,
      args: CHROME_ARGS,
      timeout: 30000,
      protocolTimeout: 30000
    });
    browser.on('disconnected', () => { browser = null; });
  }
  return browser;
}

// Simple queue to limit concurrent pages
const pageQueue = [];
let activePages = 0;
const MAX_PAGES = 1;

async function withPage(fn) {
  return new Promise((resolve, reject) => {
    pageQueue.push({ fn, resolve, reject });
    processQueue();
  });
}

async function processQueue() {
  if (activePages >= MAX_PAGES || pageQueue.length === 0) return;
  activePages++;
  const { fn, resolve, reject } = pageQueue.shift();
  try {
    const result = await fn();
    resolve(result);
  } catch (e) {
    reject(e);
  } finally {
    activePages--;
    processQueue();
    if (global.gc) global.gc(); // Trigger GC if available
  }
}

async function setupPage(page, disableImages = false) {
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const rt = req.resourceType();
    if (rt === 'font' || (disableImages && rt === 'image')) req.abort();
    else req.continue();
  });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/123');
  await page.setViewport({ width: 800, height: 600 }); // Smaller viewport
  return page;
}

// ----- Scrapers -----
async function scrapeHotPicAll(pageNum = 1) {
  const cacheKey = `home:${pageNum}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  return withPage(async () => {
    const browser = await getBrowser();
    const page = await browser.newPage();
    try {
      await setupPage(page, false); // Keep images for thumbnails
      const url = pageNum === 1 ? 'https://hotpic.one/nsfw/' : `https://hotpic.one/nsfw/${pageNum}`;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

      const anchorSelector = 'a[data-zoom="false"][href^="/album/"]';
      await page.waitForSelector(anchorSelector, { timeout: 30000 });

      const items = await page.evaluate((sel) => {
        const anchors = Array.from(document.querySelectorAll(sel));
        const origin = location.origin;
        const absolutize = (url) => {
          try { return new URL(url, origin).toString(); } catch { return url || ''; }
        };
        return anchors.map(a => {
          const href = absolutize(a.getAttribute('href') || '');
          const img = a.querySelector('img');
          const thumb = img ? absolutize(img.getAttribute('data-src') || img.getAttribute('src') || '') : '';
          const title = a.getAttribute('data-title') || a.getAttribute('title') || (img ? img.getAttribute('alt') : '') || '';
          return { href, thumb, title };
        }).filter(x => x.href);
      }, anchorSelector);

      if (!items.length) throw new Error('No album anchors found');
      cache.set(cacheKey, items);
      return items;
    } finally {
      await page.close();
    }
  });
}

async function scrapeAlbum(url) {
  const cacheKey = `album:${url}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  return withPage(async () => {
    const browser = await getBrowser();
    const page = await browser.newPage();
    try {
      await setupPage(page, true); // Disable images to save memory
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

      const primarySel = '.hotgrid .hotplay a.spotlight';
      try {
        await page.waitForSelector(primarySel, { timeout: 15000 });
      } catch {
        await page.evaluate(() => {
          window.scrollTo(0, document.body.scrollHeight);
        });
        await new Promise(resolve => setTimeout(resolve, 500));
        await page.waitForSelector(primarySel, { timeout: 15000 });
      }

      const mediaItems = await page.evaluate(() => {
        const absolutize = (u) => { try { return new URL(u, location.origin).toString(); } catch { return u || ''; } };
        const anchors = Array.from(document.querySelectorAll('.hotgrid .hotplay a.spotlight'));
        return anchors.map(a => {
          const mediaType = (a.getAttribute('data-media') || '').toLowerCase();
          const title = a.getAttribute('title') || a.getAttribute('data-title') || '';
          const href = absolutize(a.getAttribute('href') || '');
          const srcMp4 = absolutize(a.getAttribute('data-src-mp4') || '');
          const poster = absolutize(a.getAttribute('data-poster') || '');
          const isVideo = mediaType === 'video' || /\.mp4(\?|$)/i.test(srcMp4) || /\.mp4(\?|$)/i.test(href);
          if (isVideo) return { kind: 'video', src: srcMp4 || href, poster, title };
          const dataSrc = absolutize(a.getAttribute('data-src') || '');
          if (dataSrc && /\.(webp|avif|jpg|jpeg|png|gif|bmp)(\?|$)/i.test(dataSrc)) {
            return { kind: 'image', src: dataSrc, poster: '', title };
          }
          return null;
        }).filter(Boolean);
      });

      const seen = new Set();
      const deduped = mediaItems.filter(it => {
        const key = `${it.kind}:${it.src}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      if (!deduped.length) throw new Error('No media found');
      cache.set(cacheKey, deduped);
      return deduped;
    } finally {
      await page.close();
    }
  });
}

// ----- Express app -----
const app = express();
app.set('etag', false); // Disable ETag to save memory
app.use((req, res, next) => {
  res.setTimeout(60000);
  next();
});

// Health
app.get('/health', (_req, res) => res.json({ ok: true }));

// JSON APIs
app.get('/api/home', async (req, res, next) => {
  try {
    const pageNum = parseInt(req.query.page) || 1;
    const items = await scrapeHotPicAll(pageNum);
    res.json({ count: items.length, items, page: pageNum });
  } catch (e) { next(e); }
});

app.get('/api/album', async (req, res, next) => {
  try {
    const albumUrl = req.query.u;
    if (!albumUrl) return res.status(400).json({ error: 'MISSING_URL' });
    new URL(albumUrl);
    const items = await scrapeAlbum(albumUrl);
    res.json({ count: items.length, items });
  } catch (e) { next(e); }
});

// 404
app.use((_req, res) => res.status(404).json({ error: 'NOT_FOUND' }));

// Error handler
app.use((err, _req, res, _next) => {
  console.error('Error:', err.message);
  res.status(500).json({ error: 'INTERNAL', message: err.message });
});

// Clean up browser on exit
process.on('SIGTERM', async () => {
  if (browser) await browser.close();
  process.exit(0);
});

// Listen
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on http://localhost:${PORT}`));