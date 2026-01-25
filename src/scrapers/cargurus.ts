import { chromium, type Browser, type Page, type BrowserContext } from 'playwright';
import type { Scraper, ScraperResult } from './base.js';
import type { NewListing } from '../database/client.js';
import type { SearchConfig } from '../config.js';

const CARGURUS_BASE_URL = 'https://www.cargurus.ca';

// Randomize delays to appear more human-like
function randomDelay(min: number, max: number): Promise<void> {
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise(resolve => setTimeout(resolve, delay));
}

// User agents that look like real browsers
const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2.1 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
];

interface CarGurusListing {
  id: string;
  url: string;
  year: number;
  make: string;
  model: string;
  trim?: string;
  mileageKm?: number;
  price?: number;
  dealerName?: string;
  dealerRating?: number;
  city?: string;
  province?: string;
  distanceKm?: number;
  vin?: string;
  photoUrls?: string[];
}

export interface CarGurusScraperOptions {
  headless?: boolean;  // Default: false (headed mode is less likely to be blocked)
  slowMo?: number;     // Slow down actions by this many ms
}

export class CarGurusScraper implements Scraper {
  name = 'cargurus';
  private browser: Browser | null = null;
  private options: CarGurusScraperOptions;

  constructor(options: CarGurusScraperOptions = {}) {
    this.options = {
      headless: options.headless ?? false,  // Default to headed mode
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
        // Permissions that a real browser would have
        permissions: ['geolocation'],
      });

      // Add some stealth measures
      await this.addStealthMeasures(context);

      const page = await context.newPage();

      // Build search URL
      const searchUrl = this.buildSearchUrl(config);
      console.log(`Searching: ${searchUrl}`);

      await page.goto(searchUrl, { waitUntil: 'networkidle' });
      await this.handleCookieConsent(page);

      // Wait for listings to load
      await page.waitForSelector('[data-testid="srp-listing-tile"], .cg-listingCard, article', {
        timeout: 15000,
      }).catch(() => {
        console.log('No listing selector found, page might be empty or blocked');
      });

      // Get total count
      totalFound = await this.getTotalCount(page);
      console.log(`Found ${totalFound} total listings`);

      // Scrape current page
      const pageListings = await this.scrapeListingsPage(page, config);
      listings.push(...pageListings);
      pagesFetched = 1;

      // Scrape additional pages if needed (limit to first 5 pages for now)
      const maxPages = 5;
      while (pagesFetched < maxPages) {
        const hasNextPage = await this.goToNextPage(page);
        if (!hasNextPage) break;

        await page.waitForTimeout(2000); // Be polite to the server
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
    // CarGurus Canada URL structure
    // Example: https://www.cargurus.ca/Cars/inventorylisting/viewDetailsFilterViewInventoryListing.action?zip=M5V1J1&maxMileage=120000&maxPrice=20000&showNegotiable=true&sortDir=ASC&sourceContext=carGurusHomePageModel&distance=100&sortType=DEAL_SCORE&entitySelectingHelper.selectedEntity=d293

    const params = new URLSearchParams();

    // Location
    params.set('zip', config.postalCode);
    params.set('distance', config.radiusKm.toString());

    // Vehicle
    if (config.mileageMax) {
      params.set('maxMileage', config.mileageMax.toString());
    }
    if (config.priceMax) {
      params.set('maxPrice', config.priceMax.toString());
    }
    if (config.yearMin) {
      params.set('minYear', config.yearMin.toString());
    }
    if (config.yearMax) {
      params.set('maxYear', config.yearMax.toString());
    }

    // Sorting - best deals first
    params.set('sortType', 'DEAL_SCORE');
    params.set('sortDir', 'ASC');
    params.set('showNegotiable', 'true');

    // For Dodge Grand Caravan, we need the entity ID
    // This is a known ID for Grand Caravan - we might need to look this up dynamically
    // d293 = Dodge Grand Caravan
    if (config.make.toLowerCase() === 'dodge' && config.model.toLowerCase().includes('caravan')) {
      params.set('entitySelectingHelper.selectedEntity', 'd293');
    }

    return `${CARGURUS_BASE_URL}/Cars/inventorylisting/viewDetailsFilterViewInventoryListing.action?${params.toString()}`;
  }

  private async handleCookieConsent(page: Page): Promise<void> {
    try {
      const cookieButton = await page.$('button[id*="accept"], button[class*="accept"], #onetrust-accept-btn-handler');
      if (cookieButton) {
        await cookieButton.click();
        await page.waitForTimeout(500);
      }
    } catch {
      // Cookie consent might not appear, that's fine
    }
  }

  private async getTotalCount(page: Page): Promise<number> {
    try {
      // Try different selectors for the count
      const countSelectors = [
        '[data-testid="results-count"]',
        '.resultCount',
        'h1:has-text("results")',
        '.cg-listingsHeader',
      ];

      for (const selector of countSelectors) {
        const element = await page.$(selector);
        if (element) {
          const text = await element.textContent();
          if (text) {
            const match = text.match(/(\d[\d,]*)/);
            if (match) {
              return parseInt(match[1].replace(/,/g, ''), 10);
            }
          }
        }
      }
    } catch {
      // Count extraction failed, continue anyway
    }
    return 0;
  }

  private async scrapeListingsPage(page: Page, config: SearchConfig): Promise<NewListing[]> {
    const listings: NewListing[] = [];

    // Try to find listing cards with various selectors
    const cardSelectors = [
      '[data-testid="srp-listing-tile"]',
      '.cg-listingCard',
      'article[data-cg-ft="srp-listing-blade"]',
      '.listing-row',
    ];

    let cards: any[] = [];
    for (const selector of cardSelectors) {
      cards = await page.$$(selector);
      if (cards.length > 0) {
        console.log(`Found ${cards.length} cards with selector: ${selector}`);
        break;
      }
    }

    for (const card of cards) {
      try {
        const listing = await this.parseListingCard(card, config);
        if (listing) {
          listings.push(listing);
        }
      } catch (error) {
        console.error('Error parsing listing card:', error);
      }
    }

    return listings;
  }

  private async parseListingCard(card: any, config: SearchConfig): Promise<NewListing | null> {
    try {
      // Extract listing ID from the card
      const linkElement = await card.$('a[href*="/Cars/"]');
      if (!linkElement) return null;

      const href = await linkElement.getAttribute('href');
      if (!href) return null;

      // Extract ID from URL (e.g., /Cars/inventorylisting/viewDetailsFilterViewInventoryListing.action?entitySelectingHelper.selectedEntity=d293&listingId=123456)
      const idMatch = href.match(/listingId[=_](\d+)|\/(\d+)(?:\?|$)/);
      const sourceId = idMatch ? (idMatch[1] || idMatch[2]) : href;

      const sourceUrl = href.startsWith('http') ? href : `${CARGURUS_BASE_URL}${href}`;

      // Extract title (year make model)
      const titleElement = await card.$('h4, .listing-title, [data-testid="listing-title"]');
      let year = 0;
      let make = config.make;
      let model = config.model;
      let trim: string | undefined;

      if (titleElement) {
        const titleText = await titleElement.textContent();
        if (titleText) {
          const titleMatch = titleText.match(/(\d{4})\s+(\w+)\s+(.+)/);
          if (titleMatch) {
            year = parseInt(titleMatch[1], 10);
            make = titleMatch[2];
            const modelTrim = titleMatch[3].trim();
            // Split model and trim
            const parts = modelTrim.split(/\s+/);
            if (parts.length > 2) {
              model = parts.slice(0, 2).join(' '); // "Grand Caravan"
              trim = parts.slice(2).join(' ');
            } else {
              model = modelTrim;
            }
          }
        }
      }

      // Extract price
      const priceElement = await card.$('.price, [data-testid="price"], .listing-price');
      let price: number | undefined;
      if (priceElement) {
        const priceText = await priceElement.textContent();
        if (priceText) {
          const priceMatch = priceText.match(/\$?([\d,]+)/);
          if (priceMatch) {
            price = parseInt(priceMatch[1].replace(/,/g, ''), 10);
          }
        }
      }

      // Extract mileage
      const mileageElement = await card.$('.mileage, [data-testid="mileage"], .listing-mileage');
      let mileageKm: number | undefined;
      if (mileageElement) {
        const mileageText = await mileageElement.textContent();
        if (mileageText) {
          const mileageMatch = mileageText.match(/([\d,]+)\s*km/i);
          if (mileageMatch) {
            mileageKm = parseInt(mileageMatch[1].replace(/,/g, ''), 10);
          }
        }
      }

      // Extract dealer info
      const dealerElement = await card.$('.dealer-name, [data-testid="dealer-name"], .listing-dealer');
      let sellerName: string | undefined;
      if (dealerElement) {
        sellerName = (await dealerElement.textContent())?.trim();
      }

      // Extract location
      const locationElement = await card.$('.location, [data-testid="location"], .listing-location');
      let city: string | undefined;
      let province: string | undefined;
      let distanceKm: number | undefined;
      if (locationElement) {
        const locationText = await locationElement.textContent();
        if (locationText) {
          // Parse "City, ON (50 km)"
          const locationMatch = locationText.match(/([^,]+),?\s*([A-Z]{2})?\s*(?:\((\d+)\s*km\))?/i);
          if (locationMatch) {
            city = locationMatch[1]?.trim();
            province = locationMatch[2];
            if (locationMatch[3]) {
              distanceKm = parseInt(locationMatch[3], 10);
            }
          }
        }
      }

      // Extract photo URL
      const imgElement = await card.$('img');
      let photoUrls: string[] | undefined;
      if (imgElement) {
        const src = await imgElement.getAttribute('src');
        if (src && !src.includes('placeholder')) {
          photoUrls = [src];
        }
      }

      if (!year || year < 1990) {
        // Invalid listing, skip
        return null;
      }

      return {
        source: 'cargurus',
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
        province,
        distanceKm,
        photoUrls,
      };
    } catch (error) {
      console.error('Error parsing card:', error);
      return null;
    }
  }

  private async goToNextPage(page: Page): Promise<boolean> {
    try {
      const nextButton = await page.$('a[aria-label="Next page"], button:has-text("Next"), .pagination-next');
      if (nextButton) {
        const isDisabled = await nextButton.getAttribute('disabled');
        if (isDisabled) return false;

        await randomDelay(1000, 2000);
        await nextButton.click();
        await page.waitForLoadState('networkidle');
        return true;
      }
    } catch {
      // No next page
    }
    return false;
  }

  /**
   * Add stealth measures to avoid bot detection
   */
  private async addStealthMeasures(context: BrowserContext): Promise<void> {
    // Inject scripts to mask automation
    // Note: This runs in browser context, not Node.js
    await context.addInitScript(`
      // Override webdriver property
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
      });

      // Override plugins to look more realistic
      Object.defineProperty(navigator, 'plugins', {
        get: () => [
          { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
          { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
          { name: 'Native Client', filename: 'internal-nacl-plugin' },
        ],
      });

      // Override languages
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-CA', 'en-US', 'en'],
      });

      // Mock chrome runtime
      window.chrome = { runtime: {} };

      // Override permissions query
      const originalQuery = navigator.permissions?.query?.bind(navigator.permissions);
      if (originalQuery) {
        navigator.permissions.query = (parameters) => {
          if (parameters.name === 'notifications') {
            return Promise.resolve({ state: 'denied' });
          }
          return originalQuery(parameters);
        };
      }
    `);
  }
}
