// app.js
const express = require('express');
const puppeteer = require('puppeteer');

const CHROME_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome';
const CHROME_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--no-zygote',
  '--single-process'
];

// Launch helper so flags stay consistent
async function launchBrowser() {
  return puppeteer.launch({
    headless: true,
    executablePath: CHROME_PATH,
    args: CHROME_ARGS
  });
}

async function scrapeHotPicAll() {
  const browser = await launchBrowser();
  const page = await browser.newPage();

  await page.goto('https://hotpic.one/nsfw/', {
    waitUntil: 'networkidle2',
    timeout: 120000
  });

  const anchorSelector = 'a[data-zoom="false"][data-autofit="false"][data-preload="true"][data-download="true"][data-controls="false"][href^="/album/"]';

  await page.waitForSelector(anchorSelector, { timeout: 30000 });

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

  await browser.close();

  if (!items || items.length === 0) {
    throw new Error('No album anchors found');
  }
  return items;
}

// Scrape a specific album page for media items from .hotgrid .hotplay a.spotlight
async function scrapeAlbum(url) {
  const browser = await launchBrowser();
  const page = await browser.newPage();

  // Big viewport + scroll to trigger lazy-load thumbnails
  await page.setViewport({ width: 1280, height: 2200 });
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 120000 });

  await page.waitForSelector('.hotgrid .hotplay a.spotlight', { timeout: 300000 });

  // Scroll through the page to ensure lazy images load
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let y = 0;
      const step = () => {
        y += 900;
        window.scrollTo(0, y);
        if (y < document.body.scrollHeight + 1200) {
          setTimeout(step, 120);
        } else {
          setTimeout(resolve, 350);
        }
      };
      step();
    });
  });

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

      // Video branch
      const isVideo = mediaType === 'video' || /\.mp4(\?|$)/i.test(srcMp4Attr) || /\.mp4(\?|$)/i.test(hrefAttr);
      if (isVideo) {
        return { kind: 'video', src: srcMp4 || href, poster: poster || '', title };
      }

      // Image branch
      const dataSrcAttr = a.getAttribute('data-src') || '';
      let imgSrc = dataSrcAttr ? absolutize(dataSrcAttr) : '';

      if (!imgSrc) {
        const img = a.querySelector('img');
        if (img) {
          imgSrc = absolutize(img.getAttribute('data-src') || img.currentSrc || img.src || '');
        }
      }

      if (!imgSrc && href && /\.(webp|avif|jpg|jpeg|png|gif|bmp|webm)(\?|$)/i.test(hrefAttr)) {
        imgSrc = href;
      }

      if (!imgSrc) {
        const bg = (getComputedStyle(a).getPropertyValue('background-image') || '').trim();
        const m = bg.match(/url\(["']?(.*?)["']?\)/i);
        if (m && m[22]) imgSrc = absolutize(m[22]);
      }

      return imgSrc ? { kind: 'image', src: imgSrc, poster: '', title } : null;
    }).filter(Boolean);
  });

  await browser.close();

  // Deduplicate by kind+src
  const seen = new Set();
  return mediaItems.filter(it => {
    const key = `${it.kind}:${it.src}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

(async () => {
  const items = await scrapeHotPicAll();

  const app = express();

  // Simple health check for Render or any uptime monitor
  app.get('/health', (_req, res) => res.send('ok'));

  app.get('/', (req, res) => {
    const tiles = items.map(({ href, thumb, title }) => {
      const safeTitle = (title || '').replace(/"/g, '&quot;');
      const imgTag = thumb
        ? `<img src="${thumb}" alt="${safeTitle}" loading="lazy" onerror="this.style.display='none'">`
        : `<div class="placeholder" aria-label="${safeTitle}"></div>`;

      const localHref = `/album?u=${encodeURIComponent(href)}`;

      return `
        <a class="tile" href="${localHref}" target="_self" rel="noopener">
          ${imgTag}
          <div class="overlay">${safeTitle}</div>
        </a>
      `;
    }).join('');

    res.send(`
      <!doctype html>
      <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>HotPic Collage</title>
        <style>
          :root { color-scheme: dark; }
          body { margin:0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, 'Helvetica Neue', Arial; background:#0b0b0c; color:#e8e8ea; }
          header { padding:16px 20px; position:sticky; top:0; backdrop-filter:saturate(180%) blur(8px); background:rgba(11,11,12,0.7); border-bottom:1px solid #1f2024; z-index:10; }
          h1 { margin:0; font-size:18px; font-weight:700; letter-spacing:0.2px; }
          .grid {
            --min: 160px;
            display:grid;
            grid-template-columns: repeat(auto-fill, minmax(var(--min), 1fr));
            gap: 10px;
            padding: 14px;
          }
          .tile {
            position:relative;
            aspect-ratio: 3 / 4;
            display:block;
            border-radius:12px;
            overflow:hidden;
            background:#141416;
            border:1px solid #232429;
            text-decoration:none;
          }
          .tile img, .tile .placeholder {
            width:100%;
            height:100%;
            object-fit:cover;
            display:block;
          }
          .placeholder { background:linear-gradient(135deg,#1a1b20,#101114); }
          .tile .overlay {
            position:absolute;
            left:0; right:0; bottom:0;
            padding:8px 10px;
            font-size:12px;
            color:#e9e9ec;
            background:linear-gradient(to top, rgba(0,0,0,0.6), rgba(0,0,0,0));
            max-height:48%;
            overflow:hidden;
            text-overflow:ellipsis;
            display:-webkit-box;
            -webkit-line-clamp:2;
            -webkit-box-orient:vertical;
          }
          .tile::after {
            content:'';
            position:absolute; inset:0;
            box-shadow: inset 0 0 0 0 rgba(255,255,255,0.08);
            transition: box-shadow .15s ease;
          }
          .tile:hover::after { box-shadow: inset 0 0 0 2px rgba(99,102,241,0.9); }
          @media (min-width: 1200px) { .grid { --min: 200px; } }
          @media (max-width: 420px) { .grid { --min: 140px; } }
        </style>
      </head>
      <body>
        <header><h1>HotPic Collage (${items.length})</h1></header>
        <main class="grid">
          ${tiles}
        </main>
      </body>
      </html>
    `);
  });

  // Album route: scrapes media and renders a playable grid with WebP-aware fallback
  app.get('/album', async (req, res) => {
    const albumUrl = req.query.u;
    if (!albumUrl) {
      return res.status(400).send('Missing album URL');
    }

    try {
      const mediaItems = await scrapeAlbum(albumUrl);

      const imgHtml = (url, title) => {
        const safeTitle = (title || '').replace(/"/g, '&quot;');

        // Attempt sibling extension fallbacks when URL ends with .webp
        let jpg = null, png = null;
        if (/\.webp(\?|$)/i.test(url)) {
          jpg = url.replace(/\.webp(\?|$)/i, '.jpg$1');
          png = url.replace(/\.webp(\?|$)/i, '.png$1');
        }

        return `
          <figure class="cell">
            <picture>
              <source srcset="${url}" type="image/webp">
              ${jpg ? `<source srcset="${jpg}" type="image/jpeg">` : ''}
              ${png ? `<source srcset="${png}" type="image/png">` : ''}
              <img src="${jpg || png || url}" alt="${safeTitle}" loading="lazy"
                   onerror="if (this.dataset.tried!=='1'){this.dataset.tried='1'; this.src='${url}';} else { this.style.display='none'; }">
            </picture>
            <figcaption>${safeTitle}</figcaption>
          </figure>
        `;
      };

      const tiles = mediaItems.map(item => {
        const safeTitle = (item.title || '').replace(/"/g, '&quot;');
        if (item.kind === 'video') {
          return `
            <figure class="cell">
              <video controls preload="metadata" ${item.poster ? `poster="${item.poster}"` : ''}>
                <source src="${item.src}" type="video/mp4">
              </video>
              <figcaption>${safeTitle}</figcaption>
            </figure>
          `;
        } else {
          return imgHtml(item.src, item.title);
        }
      }).join('');

      res.send(`
        <!doctype html>
        <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width,initial-scale=1" />
          <title>Album Viewer</title>
          <style>
            :root { color-scheme: dark; }
            body { margin:0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, 'Helvetica Neue', Arial; background:#0b0b0c; color:#e8e8ea; }
            header { padding:12px 16px; position:sticky; top:0; backdrop-filter:saturate(180%) blur(8px); background:rgba(11,11,12,0.7); border-bottom:1px solid #1f2024; z-index:10; display:flex; gap:12px; align-items:center; }
            a.back { color:#9aa0ff; text-decoration:none; }
            main { padding:14px; }
            .grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
            .cell { margin:0; background:#141416; border:1px solid #232429; border-radius:10px; overflow:hidden; }
            .cell img, .cell video { display:block; width:100%; height:260px; object-fit:cover; background:#0f1013; }
            figcaption { font-size:12px; padding:8px 10px; color:#cfd0d6; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; border-top:1px solid #232429; }
            @media (max-width: 480px) { .cell img, .cell video { height: 200px; } }
          </style>
        </head>
        <body>
          <header>
            <a class="back" href="/">← Back</a>
            <strong>Album</strong>
          </header>
          <main>
            <div class="grid">
              ${tiles}
            </div>
          </main>
        </body>
        </html>
      `);
    } catch (err) {
      console.error('Album scrape failed:', err);
      res.status(500).send('Failed to load album');
    }
  });

  const PORT = process.env.PORT || 3000;
  const appInstance = app.listen(PORT, () => console.log(`http://localhost:${PORT}`));

  // Graceful shutdown (optional good practice)
  process.on('SIGTERM', () => {
    appInstance.close(() => process.exit(0));
  });
})().catch(err => {
  console.error('Startup failed:', err);
  process.exit(1);
});
