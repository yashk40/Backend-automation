// app.js — JSON API backend for albums/media with robust Puppeteer + proper Express ordering
const express = require('express');
const puppeteer = require('puppeteer');
const { URL } = require('url');

// ----- Puppeteer config -----
const CHROME_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome';
const CHROME_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--no-zygote',
  '--single-process'
];

async function launchBrowser() {
  return puppeteer.launch({
    headless: true,
    executablePath: CHROME_PATH,
    args: CHROME_ARGS,
    timeout: 60000
  });
}

async function setupPage(page) {
  // Lightweight interception: skip fonts to save time, keep images (thumbnails needed)
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const rt = req.resourceType();
    if (rt === 'font') req.abort();
    else req.continue();
  });

  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36'
  );
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  await page.setViewport({ width: 1280, height: 900 });
  return page;
}

// ----- Scrapers -----
async function scrapeHotPicAll(pageNum = 1) {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await setupPage(page);

    const url = pageNum === 1 ? 'https://hotpic.one/nsfw/' : `https://hotpic.one/nsfw/${pageNum}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });

    const anchorSelector =
      'a[data-zoom="false"][data-autofit="false"][data-preload="true"][data-download="true"][data-controls="false"][href^="/album/"]';

    await page.waitForSelector(anchorSelector, { timeout: 60000 });

    const items = await page.evaluate((sel) => {
      const anchors = Array.from(document.querySelectorAll(sel));
      const origin = location.origin;
      const absolutize = (url) => {
        try { return new URL(url, origin).toString(); } catch { return url || ''; }
      };

      return anchors.map(a => {
        const hrefRaw = a.getAttribute('href') || '';
        const hrefAbs = absolutize(hrefRaw);

        const img = a.querySelector('img.img-fluid') || a.querySelector('img');
        const thumbRaw = img ? (img.getAttribute('data-src') || img.getAttribute('src') || '') : '';
        const thumb = absolutize(thumbRaw);

        const title = a.getAttribute('data-title') || a.getAttribute('title') || (img ? img.getAttribute('alt') : '') || '';

        return { href: hrefAbs, thumb, title };
      }).filter(x => x.href);
    }, anchorSelector);

    if (!items || items.length === 0) throw new Error('No album anchors found');
    return items;
  } finally {
    await browser.close();
  }
}

async function scrapeAlbum(url) {
  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await setupPage(page);

    await page.setDefaultNavigationTimeout(60000);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    const primarySel = '.hotgrid .hotplay a.spotlight';
    try {
      await page.waitForSelector(primarySel, { timeout: 60000, visible: true });
    } catch {
      // Scroll to trigger lazy loads, then retry
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
      await page.waitForSelector(primarySel, { timeout: 30000 });
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
        const posterAttr = a.getAttribute('data-poster') || '';
        const poster = absolutize(posterAttr);

        // Video
        const isVideo = mediaType === 'video' || /\.mp4(\?|$)/i.test(srcMp4Attr) || /\.mp4(\?|$)/i.test(hrefAttr);
        if (isVideo) return { kind: 'video', src: srcMp4 || href, poster: poster || '', title };

        // Image
        const dataSrcAttr = a.getAttribute('data-src') || '';
        let imgSrc = dataSrcAttr ? absolutize(dataSrcAttr) : '';

        if (!imgSrc) {
          const img = a.querySelector('img');
          if (img) imgSrc = absolutize(img.getAttribute('data-src') || img.currentSrc || img.src || '');
        }
        if (!imgSrc && href && /\.(webp|avif|jpg|jpeg|png|gif|bmp)(\?|$)/i.test(hrefAttr)) {
          imgSrc = href;
        }
        if (!imgSrc) {
          const bg = (getComputedStyle(a).getPropertyValue('background-image') || '').trim();
          const m = bg.match(/url\(["']?(.*?)["']?\)/i);
          if (m && m[15]) imgSrc = absolutize(m[15]);
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
  } finally {
    if (browser) await browser.close();
  }
}

// ----- Express app (order matters) -----
const app = express();

// Optional: per-request timeouts early in stack
app.use((req, res, next) => {
  req.setTimeout?.(120000);
  res.setTimeout?.(120000);
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
    new URL(albumUrl); // validate
    const items = await scrapeAlbum(albumUrl);
    if (items.length === 0) return res.status(404).json({ error: 'NO_MEDIA' });
    res.json({ count: items.length, items });
  } catch (e) { next(e); }
});

// 404 last-but-one
app.use((_req, res) => res.status(404).json({ error: 'NOT_FOUND' }));

// Error handler LAST
app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'INTERNAL', message: String(err.message || err) });
});

// Listen
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on http://localhost:${PORT}`));
