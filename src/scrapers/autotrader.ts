import { chromium, type Browser, type Page, type BrowserContext } from 'playwright';
import type { Scraper, ScraperResult } from './base.js';
import type { NewListing } from '../database/client.js';
import type { SearchConfig } from '../config.js';

const AUTOTRADER_BASE_URL = 'https://www.autotrader.ca';

function randomDelay(min: number, max: number): Promise<void> {
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise(resolve => setTimeout(resolve, delay));
}

const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2.1 Safari/605.1.15',
];

export interface AutoTraderScraperOptions {
  headless?: boolean;
  slowMo?: number;
}

export class AutoTraderScraper implements Scraper {
  name = 'autotrader';
  private browser: Browser | null = null;
  private options: AutoTraderScraperOptions;

  constructor(options: AutoTraderScraperOptions = {}) {
    this.options = {
      headless: options.headless ?? true,  // Headless works for AutoTrader
      slowMo: options.slowMo ?? 50,
    };
  }

  async search(config: SearchConfig): Promise<ScraperResult> {
    const listings: NewListing[] = [];
    let pagesFetched = 0;
    let totalFound = 0;

    try {
      this.browser = await chromium.launch({
        headless: this.options.headless,
        slowMo: this.options.slowMo,
      });

      const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

      const context = await this.browser.newContext({
        userAgent,
        viewport: { width: 1920, height: 1080 },
        locale: 'en-CA',
        timezoneId: 'America/Toronto',
      });

      await this.addStealthMeasures(context);

      const page = await context.newPage();

      // Build search URL
      const searchUrl = this.buildSearchUrl(config);
      console.log(`Searching: ${searchUrl}`);

      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

      // Handle any overlays/modals
      await this.handleModals(page);

      // Wait for listings to load
      await page.waitForSelector('[data-testid="result-item"], .result-item, .listing-card, article', {
        timeout: 15000,
      }).catch(() => {
        console.log('No listing selector found, checking page...');
      });

      await randomDelay(2000, 3000);

      // Get total count
      totalFound = await this.getTotalCount(page);
      console.log(`Found ${totalFound} total listings`);

      // Scrape current page
      const pageListings = await this.scrapeListingsPage(page, config);
      listings.push(...pageListings);
      pagesFetched = 1;
      console.log(`Page 1: found ${pageListings.length} listings`);

      // Scrape additional pages
      const maxPages = 5;
      while (pagesFetched < maxPages) {
        const hasNextPage = await this.goToNextPage(page);
        if (!hasNextPage) break;

        await randomDelay(2000, 4000);
        const moreListings = await this.scrapeListingsPage(page, config);
        if (moreListings.length === 0) break;

        listings.push(...moreListings);
        pagesFetched++;
        console.log(`Page ${pagesFetched}: found ${moreListings.length} listings`);
      }

      await context.close();
    } finally {
      if (this.browser) {
        await this.browser.close();
        this.browser = null;
      }
    }

    return { listings, totalFound, pagesFetched };
  }

  private buildSearchUrl(config: SearchConfig): string {
    // AutoTrader.ca URL structure (based on working example):
    // https://www.autotrader.ca/cars/dodge%20or%20ram/grand%20caravan/on/toronto/?rcp=15&rcs=0&srt=39&pRng=10000%2C18000&oRng=0%2C120000&prx=250&prv=Ontario&loc=M5T%203J9&hprc=True&wcp=True&sts=New-Used&inMarket=advancedSearch

    const params = new URLSearchParams();

    // Location
    params.set('loc', config.postalCode);
    params.set('prx', config.radiusKm.toString());
    params.set('prv', 'Ontario'); // Province

    // Filters
    if (config.mileageMax) {
      params.set('oRng', `0,${config.mileageMax}`); // Odometer range (correct param name)
    }
    if (config.priceMax) {
      // Use a reasonable minimum price to filter out obvious errors
      params.set('pRng', `5000,${config.priceMax}`);
    }
    if (config.yearMin && config.yearMax) {
      params.set('yRng', `${config.yearMin},${config.yearMax}`);
    }

    params.set('rcp', '100'); // Results per page
    params.set('rcs', '0'); // Results start (offset)
    params.set('srt', '39'); // Sort by best match
    params.set('sts', 'New-Used'); // Include both new and used
    params.set('hprc', 'True'); // Has price
    params.set('wcp', 'True'); // With car proof
    params.set('inMarket', 'advancedSearch');

    // Build the path for make/model - use URL encoding for spaces
    // For Dodge Grand Caravan, also include RAM since they made some models
    let make = config.make.toLowerCase();
    if (make === 'dodge') {
      make = 'dodge or ram'; // Include RAM variants
    }
    const model = config.model.toLowerCase(); // Keep spaces, will be encoded

    // Encode properly for URL path
    const encodedMake = encodeURIComponent(make);
    const encodedModel = encodeURIComponent(model);

    // Include province in path (on = Ontario)
    return `${AUTOTRADER_BASE_URL}/cars/${encodedMake}/${encodedModel}/on/?${params.toString()}`;
  }

  private async handleModals(page: Page): Promise<void> {
    try {
      // Close any popups or modals
      const closeButtons = [
        'button[aria-label="Close"]',
        '.modal-close',
        '[data-testid="modal-close"]',
        'button:has-text("No thanks")',
        'button:has-text("Maybe later")',
      ];

      for (const selector of closeButtons) {
        const button = await page.$(selector);
        if (button && await button.isVisible()) {
          await button.click();
          await randomDelay(500, 1000);
        }
      }

      // Accept cookies if prompted
      const cookieButton = await page.$('button:has-text("Accept"), #onetrust-accept-btn-handler');
      if (cookieButton && await cookieButton.isVisible()) {
        await cookieButton.click();
        await randomDelay(500, 1000);
      }
    } catch {
      // Modals might not appear
    }
  }

  private async getTotalCount(page: Page): Promise<number> {
    try {
      const countSelectors = [
        '[data-testid="results-count"]',
        '.results-count',
        '.result-count',
        'h1',
      ];

      for (const selector of countSelectors) {
        const element = await page.$(selector);
        if (element) {
          const text = await element.textContent();
          if (text) {
            // Match patterns like "123 results" or "Showing 123 vehicles"
            const match = text.match(/(\d[\d,]*)\s*(results?|vehicles?|listings?|cars?)/i);
            if (match) {
              return parseInt(match[1].replace(/,/g, ''), 10);
            }
          }
        }
      }
    } catch {
      // Count extraction failed
    }
    return 0;
  }

  private async scrapeListingsPage(page: Page, config: SearchConfig): Promise<NewListing[]> {
    const listings: NewListing[] = [];

    // AutoTrader uses .result-item for listing cards
    const cards = await page.$$('.result-item');
    if (cards.length > 0) {
      console.log(`Found ${cards.length} listing cards`);
    } else {
      console.log('No listing cards found on this page');
      return listings;
    }

    for (const card of cards) {
      try {
        const listing = await this.parseListingCard(card, config);
        if (listing) {
          listings.push(listing);
        }
      } catch (error) {
        // Log but continue with other cards
        const cardId = await card.getAttribute('id').catch(() => 'unknown');
        console.error(`Error parsing card ${cardId}:`, error);
      }
    }

    return listings;
  }

  private async parseListingCard(card: any, config: SearchConfig): Promise<NewListing | null> {
    try {
      // Get the card ID from the element's id attribute
      const cardId = await card.getAttribute('id');

      // Find the main link to get URL
      const linkElement = await card.$('a.inner-link, a[href*="/a/"]');
      if (!linkElement) return null;

      const href = await linkElement.getAttribute('href');
      if (!href) return null;

      // Extract ID from URL: /a/dodge/grand%20caravan/north%20york/ontario/5_68339128_20190502164350235/
      const idMatch = href.match(/(\d+_\d+_\d+)\/?$/);
      const sourceId = idMatch ? idMatch[1] : (cardId || href.replace(/\//g, '_'));

      const sourceUrl = href.startsWith('http') ? href : `${AUTOTRADER_BASE_URL}${href}`;

      // Extract title from .title-with-trim or h2
      const titleElement = await card.$('.title-with-trim, .h2-title, h2');
      let year = 0;
      let make = config.make;
      let model = config.model;
      let trim: string | undefined;

      if (titleElement) {
        const titleText = await titleElement.textContent();
        if (titleText) {
          const cleanTitle = titleText.trim();
          // Match "2016 Dodge Grand Caravan 4dr Wgn Canada Value Package"
          const titleMatch = cleanTitle.match(/(\d{4})\s+(\w+)\s+(.+)/);
          if (titleMatch) {
            year = parseInt(titleMatch[1], 10);
            make = titleMatch[2];
            const modelTrim = titleMatch[3].trim();
            // For Grand Caravan, extract model and trim
            // Pattern: "Grand Caravan <body style> <trim>"
            const caravanMatch = modelTrim.match(/(Grand\s+Caravan)(?:\s+\d+dr\s+\w+)?\s*(.*)/i);
            if (caravanMatch) {
              model = caravanMatch[1];
              trim = caravanMatch[2]?.trim() || undefined;
            } else {
              model = modelTrim;
            }
          }
        }
      }

      // Extract price from .price-amount
      let price: number | undefined;
      const priceElement = await card.$('.price-amount, .price');
      if (priceElement) {
        const priceText = await priceElement.textContent();
        if (priceText) {
          const priceMatch = priceText.match(/\$?([\d,]+)/);
          if (priceMatch) {
            price = parseInt(priceMatch[1].replace(/,/g, ''), 10);
          }
        }
      }

      // Extract mileage from .odometer-proximity or .kms
      let mileageKm: number | undefined;
      const mileageElement = await card.$('.odometer-proximity, .kms');
      if (mileageElement) {
        const mileageText = await mileageElement.textContent();
        if (mileageText) {
          const mileageMatch = mileageText.match(/([\d,]+)\s*km/i);
          if (mileageMatch) {
            mileageKm = parseInt(mileageMatch[1].replace(/,/g, ''), 10);
          }
        }
      }

      // Extract dealer name from .seller-name
      let sellerName: string | undefined;
      const dealerElement = await card.$('.seller-name');
      if (dealerElement) {
        sellerName = (await dealerElement.textContent())?.trim();
      }

      // Extract location from .proximity-text
      let city: string | undefined;
      let distanceKm: number | undefined;
      const proximityElements = await card.$$('.proximity-text');
      if (proximityElements.length > 0) {
        // First proximity-text is usually the city
        const cityText = await proximityElements[0].textContent();
        city = cityText?.trim();

        // Second proximity-text may have distance
        if (proximityElements.length > 1) {
          const distText = await proximityElements[1].textContent();
          const distMatch = distText?.match(/(\d+)\s*km/i);
          if (distMatch) {
            distanceKm = parseInt(distMatch[1], 10);
          }
        }
      }

      // Extract photo from img.photo-image
      let photoUrls: string[] | undefined;
      const imgElement = await card.$('img.photo-image');
      if (imgElement) {
        const src = await imgElement.getAttribute('src');
        if (src && src.startsWith('http') && !src.includes('placeholder') && !src.includes('base64')) {
          photoUrls = [src];
        }
      }

      // Extract description
      let description: string | undefined;
      const descElement = await card.$('p.details');
      if (descElement) {
        description = (await descElement.textContent())?.trim().slice(0, 500);
      }

      if (!year || year < 1990) {
        return null;
      }

      return {
        source: 'autotrader',
        sourceId,
        sourceUrl,
        year,
        make,
        model,
        trim,
        price,
        mileageKm,
        sellerType: 'dealer',
        sellerName,
        city,
        province: 'ON', // We're searching in Ontario
        distanceKm,
        photoUrls,
        description,
      };
    } catch (error) {
      console.error('Error parsing card:', error);
      return null;
    }
  }

  private async goToNextPage(page: Page): Promise<boolean> {
    try {
      const nextButton = await page.$('a[aria-label="Next"], button[aria-label="Next"], .pagination-next, a:has-text("Next")');
      if (nextButton) {
        const isDisabled = await nextButton.getAttribute('disabled');
        const ariaDisabled = await nextButton.getAttribute('aria-disabled');
        if (isDisabled || ariaDisabled === 'true') return false;

        await randomDelay(1000, 2000);
        await nextButton.click();
        await page.waitForLoadState('domcontentloaded');
        await randomDelay(1000, 2000);
        return true;
      }
    } catch {
      // No next page
    }
    return false;
  }

  private async addStealthMeasures(context: BrowserContext): Promise<void> {
    await context.addInitScript(`
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', {
        get: () => [
          { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
          { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
        ],
      });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-CA', 'en-US', 'en'] });
      window.chrome = { runtime: {} };
    `);
  }
}
