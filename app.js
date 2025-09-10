// app.js - Updated version with better error handling and reliability
const express = require('express');
const puppeteer = require('puppeteer');
const { URL } = require('url');

const CHROME_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome';
const CHROME_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--no-zygote',
  '--single-process',
  '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
];

// Enhanced launch helper with better configuration
async function launchBrowser() {
  return puppeteer.launch({
    headless: 'new',
    executablePath: CHROME_PATH,
    args: CHROME_ARGS,
    timeout: 60000
  });
}

// Add request interception to block unnecessary resources
async function setupPage(page) {
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const resourceType = request.resourceType();
    // Block images, fonts, and media on initial load to speed things up
    if (['image', 'font', 'media'].includes(resourceType)) {
      request.abort();
    } else {
      request.continue();
    }
  });
  
  await page.setViewport({ width: 1280, height: 800 });
  return page;
}

// Scrape a specific album page with improved reliability
async function scrapeAlbum(url) {
  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    
    // Set up request interception
    await setupPage(page);
    
    // Set a reasonable timeout
    await page.setDefaultNavigationTimeout(60000);
    
    console.log(`Navigating to: ${url}`);
    await page.goto(url, { 
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    // Wait for the main content with a more flexible approach
    try {
      await page.waitForSelector('.hotgrid, .hotplay, a.spotlight', { 
        timeout: 30000 
      });
    } catch (e) {
      console.log('Primary selectors not found, trying fallback...');
      // Fallback: check if page loaded at all
      await page.waitForSelector('body', { timeout: 10000 });
    }

    // More efficient scrolling with better detection of content
    await page.evaluate(async () => {
      await new Promise((resolve) => {
        let totalHeight = 0;
        const distance = 500;
        const timer = setInterval(() => {
          const scrollHeight = document.body.scrollHeight;
          window.scrollBy(0, distance);
          totalHeight += distance;
          
          if (totalHeight >= scrollHeight || totalHeight > 5000) {
            clearInterval(timer);
            setTimeout(resolve, 1000);
          }
        }, 200);
      });
    });

    // Try multiple selector strategies
    const mediaItems = await page.evaluate(() => {
      const absolutize = (u) => { 
        try { 
          return new URL(u, location.origin).toString(); 
        } catch { 
          return u || ''; 
        } 
      };
      
      // Try multiple selector patterns
      const selectors = [
        '.hotgrid .hotplay a.spotlight',
        'a[data-media]',
        '.hotgrid a',
        'a.spotlight'
      ];
      
      let anchors = [];
      for (const selector of selectors) {
        const elements = document.querySelectorAll(selector);
        if (elements.length > 0) {
          anchors = Array.from(elements);
          break;
        }
      }
      
      if (anchors.length === 0) {
        // Last resort: find any media links
        anchors = Array.from(document.querySelectorAll('a')).filter(a => {
          const href = a.getAttribute('href') || '';
          return /\.(jpg|jpeg|png|gif|webp|mp4|webm|avi)$/i.test(href);
        });
      }

      return anchors.map(a => {
        const mediaType = (a.getAttribute('data-media') || '').toLowerCase();
        const title = a.getAttribute('title') || a.getAttribute('data-title') || '';
        const hrefAttr = a.getAttribute('href') || '';
        const href = absolutize(hrefAttr);
        const srcMp4Attr = a.getAttribute('data-src-mp4') || '';
        const srcMp4 = absolutize(srcMp4Attr);
        const posterAttr = a.getAttribute('data-poster') || '';
        const poster = absolutize(posterAttr);

        // Video detection
        const isVideo = mediaType === 'video' || 
                       /\.mp4(\?|$)/i.test(srcMp4Attr) || 
                       /\.mp4(\?|$)/i.test(hrefAttr) ||
                       srcMp4Attr.length > 0;
        
        if (isVideo) {
          return { 
            kind: 'video', 
            src: srcMp4 || href, 
            poster: poster || '', 
            title 
          };
        }

        // Image detection
        const dataSrcAttr = a.getAttribute('data-src') || '';
        let imgSrc = dataSrcAttr ? absolutize(dataSrcAttr) : '';

        if (!imgSrc) {
          const img = a.querySelector('img');
          if (img) {
            imgSrc = absolutize(img.getAttribute('data-src') || img.currentSrc || img.src || '');
          }
        }

        if (!imgSrc && href && /\.(webp|avif|jpg|jpeg|png|gif|bmp)(\?|$)/i.test(hrefAttr)) {
          imgSrc = href;
        }

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
    const uniqueItems = mediaItems.filter(it => {
      const key = `${it.kind}:${it.src}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    console.log(`Found ${uniqueItems.length} media items`);
    return uniqueItems;
    
  } catch (error) {
    console.error('Album scraping error:', error);
    throw new Error(`Failed to scrape album: ${error.message}`);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

// Add error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).send(`
    <!doctype html>
    <html>
    <head><title>Error</title></head>
    <body>
      <h1>Something went wrong</h1>
      <p>${error.message}</p>
      <a href="/">Go back to homepage</a>
    </body>
    </html>
  `);
});

// Update your album route with better error handling
app.get('/album', async (req, res, next) => {
  const albumUrl = req.query.u;
  if (!albumUrl) {
    return res.status(400).send('Missing album URL');
  }

  try {
    // Validate URL
    new URL(albumUrl);
    
    const mediaItems = await scrapeAlbum(albumUrl);
    
    if (mediaItems.length === 0) {
      return res.status(404).send('No media items found in this album');
    }

    // Rest of your rendering code remains the same...
    // [Keep your existing HTML rendering code here]
    
  } catch (error) {
    next(error); // Pass to error handling middleware
  }
});

// Add a timeout middleware
app.use((req, res, next) => {
  req.setTimeout(120000, () => {
    res.status(504).send('Request timeout');
  });
  next();
});