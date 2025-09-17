import puppeteer from "puppeteer-core";
import Proxifly from 'proxifly';

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const URL = "https://fragrant-tooth-c9f0.ykumawat006-372.workers.dev/?url=https://mmsleak.com/forum/2-desi-new-videos-hdsd/?do=add";
const PROXIFLY_API_KEY = '6NtJEpG4xbxEKMzin225QwpX7bnabeZLMamvCCoe7pkk';

// Initialize Proxifly
const proxifly = new Proxifly({ apiKey: PROXIFLY_API_KEY });

// Function to get fresh proxies
const getProxy = async () => {
  try {
    console.log("Fetching fresh proxies from Proxifly...");
    const result = await proxifly.getProxy({
      countries: ['US', 'RU'],
      protocol: ['http', 'socks4'],
      quantity: 20,
      https: true
    });
    
    console.log(`Got ${result.proxies.length} proxies`);
    
    // Select a random proxy from the list
    const randomProxy = result.proxies[Math.floor(Math.random() * result.proxies.length)];
    console.log(`Selected proxy: ${randomProxy.ip}:${randomProxy.port}`);
    
    return {
      server: `http://${randomProxy.ip}:${randomProxy.port}`,
      username: randomProxy.username,
      password: randomProxy.password
    };
    
  } catch (error) {
    console.error("Error fetching proxies:", error.message);
    throw error;
  }
};

const launch = async () => {
  try {
    // Get a fresh proxy
    const proxy = await getProxy();
    
    const browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: false, // Browser will be visible
      defaultViewport: null, // Full window size
      args: [
        `--proxy-server=${proxy.server}`,
        "--start-maximized",
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--window-size=1400,900",
        "--ignore-certificate-errors",
        "--ignore-ssl-errors",
      ],
      protocolTimeout: 180000,
    });
    
    return { browser, proxy };
    
  } catch (error) {
    console.error("Failed to launch browser with proxy:", error.message);
    // Fallback to no proxy
    console.log("Falling back to no proxy...");
    return {
      browser: await puppeteer.launch({
        executablePath: CHROME,
        headless: false,
        defaultViewport: null,
        args: [
          "--start-maximized",
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--window-size=1400,900",
        ],
        protocolTimeout: 180000,
      }),
      proxy: null
    };
  }
};

// Function to authenticate proxy if needed
const authenticateProxy = async (page, proxy) => {
  if (proxy && proxy.username && proxy.password) {
    console.log("Authenticating proxy...");
    await page.authenticate({
      username: proxy.username,
      password: proxy.password
    });
  }
};

const gotoWithRetry = async (page, url, tries = 3) => {
  let last;
  for (let i = 1; i <= tries; i++) {
    try {
      console.log(`Navigation attempt ${i}...`);
      
      // Clear cookies and cache between attempts
      if (i > 1) {
        const client = await page.target().createCDPSession();
        await client.send('Network.clearBrowserCookies');
        await client.send('Network.clearBrowserCache');
      }
      
      const resp = await page.goto(url, { 
        waitUntil: "domcontentloaded", 
        timeout: 120000 
      });
      
      if (!resp) throw new Error("No response received");
      if (!resp.ok()) {
        console.log(`Response status: ${resp.status()}`);
        throw new Error(`Bad response: ${resp.status()}`);
      }
      
      // Wait for page to load completely
      await page.waitForTimeout(3000);
      
      // Check for proxy errors or captchas
      const pageContent = await page.content();
      if (pageContent.includes('proxy') || pageContent.includes('captcha') || 
          pageContent.includes('access denied') || pageContent.includes('cloudflare')) {
        throw new Error("Proxy or security challenge detected");
      }
      
      // Try multiple selectors for form detection
      const selectors = [
        'input[placeholder="Title"]',
        'input[name="title"]',
        'input[name*="title"]',
        'form',
        'input[type="text"]',
        '#title',
        '.title-input',
        'textarea',
        'input'
      ];
      
      let formFound = false;
      for (const selector of selectors) {
        try {
          await page.waitForSelector(selector, { timeout: 5000 });
          console.log(`Found selector: ${selector}`);
          formFound = true;
          break;
        } catch (e) {
          // Continue to next selector
        }
      }
      
      if (!formFound) {
        console.log("No specific form elements found, checking page content...");
        if (pageContent.includes('login') || pageContent.includes('password')) {
          throw new Error("Login page detected");
        }
        console.log("Continuing with available elements...");
      }
      
      return;
    } catch (e) {
      last = e;
      console.warn(`Attempt ${i} failed: ${e.message}`);
      
      // If proxy fails, try without proxy on next attempt
      if (e.message.includes('proxy') || e.message.includes('ECONNREFUSED')) {
        console.log("Proxy appears to be blocked or dead");
      }
      
      await page.waitForTimeout(3000 * i);
    }
  }
  throw last;
};

// Function to fill form data
const fillForm = async (page) => {
  try {
    console.log("Looking for form elements...");
    
    // Fill title field
    const titleSelectors = [
      'input[placeholder="Title"]',
      'input[name="title"]',
      'input[name*="title"]',
      '#title',
      '.title-input',
      'input[type="text"]'
    ];
    
    let titleFilled = false;
    for (const selector of titleSelectors) {
      try {
        await page.waitForSelector(selector, { timeout: 3000 });
        await page.click(selector, { clickCount: 3 });
        await page.type(selector, 'Test Title - Automated Post with Proxy', { delay: 50 });
        console.log(`Title filled using selector: ${selector}`);
        titleFilled = true;
        break;
      } catch (e) {
        // Continue to next selector
      }
    }
    
    if (!titleFilled) {
      console.log("No title field found, trying first input field...");
      try {
        const firstInput = await page.$('input');
        if (firstInput) {
          await firstInput.click({ clickCount: 3 });
          await firstInput.type('Test Title - Automated Post with Proxy', { delay: 50 });
          console.log("Filled first available input field");
        }
      } catch (e) {
        console.warn("Could not fill any input field:", e.message);
      }
    }
    
    // Fill content/description
    const contentSelectors = [
      'textarea[name="content"]',
      'textarea[placeholder*="Content"]',
      'textarea[placeholder*="Message"]',
      'textarea[placeholder*="Description"]',
      '#content',
      '.content-textarea',
      'textarea'
    ];
    
    let contentFilled = false;
    for (const selector of contentSelectors) {
      try {
        await page.waitForSelector(selector, { timeout: 3000 });
        await page.click(selector, { clickCount: 3 });
        await page.type(selector, 'This is automated test content created by puppeteer bot using rotating proxies. This post is for testing purposes only.', { delay: 30 });
        console.log(`Content filled using selector: ${selector}`);
        contentFilled = true;
        break;
      } catch (e) {
        // Continue to next selector
      }
    }
    
    // Submit form
    console.log("Looking for submit button...");
    const submitSelectors = [
      'input[type="submit"]',
      'button[type="submit"]',
      'button:contains("Submit")',
      'button:contains("Post")',
      'button:contains("Create")',
      'button:contains("Send")',
      '#submit-btn',
      '.submit-button',
      'form button',
      'form input[type="submit"]'
    ];
    
    let submitted = false;
    for (const selector of submitSelectors) {
      try {
        await page.waitForSelector(selector, { timeout: 3000 });
        await page.click(selector);
        console.log(`Form submitted using selector: ${selector}`);
        submitted = true;
        await page.waitForTimeout(5000);
        break;
      } catch (e) {
        // Continue to next selector
      }
    }
    
    if (!submitted) {
      console.log("No submit button found, trying Enter key...");
      await page.keyboard.press('Enter');
      await page.waitForTimeout(3000);
    }
    
    // Check if submission was successful
    const currentUrl = page.url();
    console.log("Final URL:", currentUrl);
    
    if (currentUrl.includes('success') || currentUrl.includes('thank') || !currentUrl.includes('do=add')) {
      console.log("✅ Form submission appears successful!");
    } else {
      console.log("⚠️  Form submission status unclear");
    }
    
  } catch (error) {
    console.warn("Form filling error:", error.message);
  }
};

// Function to handle potential popups or dialogs
const handleDialogs = (page) => {
  page.on('dialog', async (dialog) => {
    console.log(`Dialog detected: ${dialog.message()}`);
    await dialog.dismiss();
  });
};

(async () => {
  let browser;
  try {
    console.log("Launching browser with proxy...");
    const { browser: launchedBrowser, proxy } = await launch();
    browser = launchedBrowser;
    
    const page = await browser.newPage();
    
    // Authenticate proxy if needed
    if (proxy) {
      await authenticateProxy(page, proxy);
    }
    
    // Handle dialogs
    handleDialogs(page);
    
    // Set user agent
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
    
    // Log console messages from the page
    page.on('console', msg => console.log('PAGE LOG:', msg.text()));
    
    // Log network events
    page.on('requestfailed', request => {
      console.log('Request failed:', request.url(), request.failure().errorText);
    });
    
    console.log("Navigating to target URL with proxy...");
    await gotoWithRetry(page, URL, 3);
    
    console.log("Page loaded successfully!");
    console.log("Current URL:", page.url());
    console.log("Page title:", await page.title());
    
    // Wait a moment for user to see the page
    await page.waitForTimeout(2000);
    
    // Fill and submit the form
    console.log("Starting form filling process...");
    await fillForm(page);
    
    // Keep browser open for inspection
    console.log("Process completed. Browser will remain open for inspection.");
    console.log("Press Ctrl+C to close the browser.");
    
    // Keep the browser open indefinitely
    await new Promise(() => {});
    
  } catch (err) {
    console.error("Fatal error:", err.message);
    console.error(err.stack);
    if (browser) await browser.close();
  }
})();