/**
 * Contact dealers through website forms using Playwright
 */

import { chromium, type Browser, type Page, type BrowserContext } from 'playwright';
import { getEnv } from '../config.js';
import type { Listing } from '../database/client.js';

function randomDelay(min: number, max: number): Promise<void> {
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise(resolve => setTimeout(resolve, delay));
}

const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2.1 Safari/605.1.15',
];

export interface ContactFormData {
  name: string;
  email: string;
  phone?: string;
  message: string;
}

export interface ContactResult {
  success: boolean;
  method: 'web_form' | 'email_extracted' | 'phone_extracted';
  message: string;
  dealerEmail?: string;
  dealerPhone?: string;
  screenshotPath?: string;
}

export class WebFormContact {
  private browser: Browser | null = null;

  /**
   * Contact dealer through AutoTrader listing page
   */
  async contactViaAutoTrader(
    listing: Listing,
    formData: ContactFormData,
    options: { headless?: boolean; dryRun?: boolean } = {}
  ): Promise<ContactResult> {
    const headless = options.headless ?? false; // Show browser by default for contact
    const dryRun = options.dryRun ?? false;

    try {
      this.browser = await chromium.launch({
        headless,
        slowMo: 100,
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

      console.log(`Opening listing: ${listing.sourceUrl}`);
      await page.goto(listing.sourceUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await randomDelay(2000, 3000);

      // Handle modals/popups
      await this.handleModals(page);

      // Look for contact form or button
      const contactResult = await this.findAndFillContactForm(page, formData, dryRun);

      if (contactResult.success) {
        return contactResult;
      }

      // If no form found, try to extract dealer contact info
      const extractedInfo = await this.extractDealerInfo(page);

      if (extractedInfo.email || extractedInfo.phone) {
        return {
          success: true,
          method: extractedInfo.email ? 'email_extracted' : 'phone_extracted',
          message: `Contact info extracted - Email: ${extractedInfo.email || 'N/A'}, Phone: ${extractedInfo.phone || 'N/A'}`,
          dealerEmail: extractedInfo.email,
          dealerPhone: extractedInfo.phone,
        };
      }

      return {
        success: false,
        method: 'web_form',
        message: 'Could not find contact form or dealer info on page',
      };

    } finally {
      if (this.browser) {
        await this.browser.close();
        this.browser = null;
      }
    }
  }

  private async findAndFillContactForm(
    page: Page,
    formData: ContactFormData,
    dryRun: boolean
  ): Promise<ContactResult> {
    // AutoTrader uses SPA forms without traditional <form> elements
    // First check if we need to open a contact modal/form
    const contactButtonSelectors = [
      'button:has-text("Contact Dealer")',
      'button:has-text("Contact Seller")',
      'button:has-text("Email Dealer")',
      'button:has-text("Request Info")',
      'a:has-text("Contact Dealer")',
      'a:has-text("Email Dealer")',
      '[data-testid="contact-dealer"]',
      '.contact-dealer-btn',
      '.email-dealer-btn',
    ];

    for (const selector of contactButtonSelectors) {
      try {
        const button = await page.$(selector);
        if (button && await button.isVisible()) {
          console.log(`Clicking contact button: ${selector}`);
          await button.click();
          await randomDelay(1500, 2500);
          break;
        }
      } catch {
        continue;
      }
    }

    // Look for contact form fields directly on the page (SPA-style)
    // Check if we have the essential fields (name, email)
    const nameField = await page.$('input[name*="name" i], input[placeholder*="Name" i], input[aria-label*="Name" i]');
    const emailField = await page.$('input[type="email"], input[name*="email" i], input[placeholder*="Email" i]');

    if (!nameField && !emailField) {
      console.log('No contact form fields found');
      return {
        success: false,
        method: 'web_form',
        message: 'Contact form not found',
      };
    }

    console.log('Found contact form fields');

    // Fill in the form
    console.log('Filling contact form...');

    // Name field - AutoTrader uses various selectors
    const nameSelectors = [
      'input[name="firstName"]',
      'input[name="name"]',
      'input[name*="name" i]',
      'input[placeholder*="Name" i]',
      'input[aria-label*="Name" i]',
      'input[id*="name" i]',
      'input[autocomplete="name"]',
      'input[autocomplete="given-name"]',
    ];
    let nameFilled = false;
    for (const selector of nameSelectors) {
      try {
        const field = await page.$(selector);
        if (field && await field.isVisible()) {
          await field.fill(formData.name);
          console.log(`  Filled name: ${formData.name}`);
          nameFilled = true;
          break;
        }
      } catch {
        continue;
      }
    }
    if (!nameFilled) {
      console.log('  Warning: Could not find name field');
    }

    // Email field
    const emailSelectors = [
      'input[type="email"]',
      'input[name*="email"]',
      'input[placeholder*="Email"]',
      'input[id*="email"]',
    ];
    for (const selector of emailSelectors) {
      const field = await page.$(selector);
      if (field && await field.isVisible()) {
        await field.fill(formData.email);
        console.log(`  Filled email: ${formData.email}`);
        break;
      }
    }

    // Phone field (optional)
    if (formData.phone) {
      const phoneSelectors = [
        'input[type="tel"]',
        'input[name*="phone"]',
        'input[placeholder*="Phone"]',
        'input[id*="phone"]',
      ];
      for (const selector of phoneSelectors) {
        const field = await page.$(selector);
        if (field && await field.isVisible()) {
          await field.fill(formData.phone);
          console.log(`  Filled phone: ${formData.phone}`);
          break;
        }
      }
    }

    // Message field
    const messageSelectors = [
      'textarea[name*="message"]',
      'textarea[name*="comment"]',
      'textarea[placeholder*="Message"]',
      'textarea[id*="message"]',
      'textarea',
    ];
    for (const selector of messageSelectors) {
      const field = await page.$(selector);
      if (field && await field.isVisible()) {
        await field.fill(formData.message);
        console.log(`  Filled message: ${formData.message.slice(0, 50)}...`);
        break;
      }
    }

    // Uncheck "Get price alerts" checkbox to avoid spam
    // Modern UIs use custom checkboxes - find labels/containers and click them
    const spamPatterns = ['price alert', 'similar listing', 'newsletter', 'subscribe', 'marketing', 'get alert'];

    // Method 1: Find labels with spam-related text
    const allLabels = await page.$$('label');
    for (const label of allLabels) {
      try {
        const text = (await label.textContent())?.toLowerCase() || '';
        const visible = await label.isVisible();
        if (!visible) continue;

        const isSpamCheckbox = spamPatterns.some(pattern => text.includes(pattern));
        if (isSpamCheckbox) {
          // Check if there's a checked checkbox inside or associated
          const checkbox = await label.$('input[type="checkbox"]');
          if (checkbox) {
            const isChecked = await checkbox.isChecked();
            if (isChecked) {
              await label.click();
              console.log('  Unchecked via label: ' + text.trim().slice(0, 50));
            }
          }
        }
      } catch {
        continue;
      }
    }

    // Method 2: Find any element with spam-related text that looks clickable
    for (const pattern of spamPatterns) {
      try {
        const element = await page.$(`text=${pattern}`);
        if (element && await element.isVisible()) {
          // Find nearby checkbox
          const parent = await element.evaluateHandle(el => el.closest('label') || el.parentElement);
          const checkbox = await (parent as any).$('input[type="checkbox"]');
          if (checkbox) {
            const isChecked = await checkbox.isChecked();
            if (isChecked) {
              await (parent as any).click();
              console.log('  Unchecked via text: ' + pattern);
            }
          }
        }
      } catch {
        continue;
      }
    }

    await randomDelay(1000, 2000);

    if (dryRun) {
      console.log('\n[DRY RUN - Form filled but not submitted]');
      // Take screenshot for verification
      const screenshotPath = `/tmp/contact-form-${Date.now()}.png`;
      await page.screenshot({ path: screenshotPath, fullPage: false });
      console.log(`Screenshot saved: ${screenshotPath}`);

      return {
        success: true,
        method: 'web_form',
        message: 'Form filled successfully (dry run - not submitted)',
        screenshotPath,
      };
    }

    // Find and click submit button
    // AutoTrader uses "Send Email" button with scr-button--primary class
    const submitSelectors = [
      'button.scr-button--primary:has-text("Send")',
      'button.scr-button--primary:has-text("Send Email")',
      '[class*="CTAs"] button:has-text("Send")',
      'button:has-text("Send Email")',
      'button:has-text("Send Message")',
      'button[type="submit"]:has-text("Send")',
      'button[type="submit"]',
      'button:has-text("Submit")',
      'input[type="submit"]',
    ];

    let submitButton = null;
    let usedSelector = '';

    // First try: find ALL buttons and look for visible "Send" button
    const allButtons = await page.$$('button');
    for (const btn of allButtons) {
      try {
        const text = (await btn.textContent())?.trim().toLowerCase() || '';
        const visible = await btn.isVisible();
        if (visible && (text === 'send' || text === 'send email' || text === 'send message' || text === 'submit')) {
          submitButton = btn;
          usedSelector = `button:"${text}"`;
          break;
        }
      } catch {
        continue;
      }
    }

    // Fallback: try CSS selectors
    if (!submitButton) {
      for (const selector of submitSelectors) {
        try {
          const button = await page.$(selector);
          if (button && await button.isVisible()) {
            submitButton = button;
            usedSelector = selector;
            break;
          }
        } catch {
          continue;
        }
      }
    }

    if (!submitButton) {
      console.log('Could not find submit button');
      return {
        success: false,
        method: 'web_form',
        message: 'Could not find submit button',
      };
    }

    console.log(`Submitting form (using ${usedSelector})...`);

    // Click the submit button
    await submitButton.click();
    await randomDelay(3000, 4000);

    // Check for success indicators
    const pageContent = await page.textContent('body') || '';
    const successPatterns = [
      /thank you/i,
      /message sent/i,
      /submitted successfully/i,
      /we('ll| will) (get back|contact|reach)/i,
      /inquiry (has been |was )?received/i,
    ];

    for (const pattern of successPatterns) {
      if (pattern.test(pageContent)) {
        console.log('Form submitted successfully!');
        return {
          success: true,
          method: 'web_form',
          message: 'Contact form submitted successfully',
        };
      }
    }

    // Check if form disappeared (another success indicator)
    const formStillVisible = await page.$('form[class*="lead"], form[class*="contact"]');
    if (!formStillVisible) {
      console.log('Form no longer visible - assuming success');
      return {
        success: true,
        method: 'web_form',
        message: 'Form submitted (form closed)',
      };
    }

    // If we got here, form might have submitted but no clear indicator
    console.log('Form clicked but no clear success indicator');
    return {
      success: true,
      method: 'web_form',
      message: 'Form submitted (no confirmation detected)',
    };
  }

  private async extractDealerInfo(page: Page): Promise<{ email?: string; phone?: string }> {
    const result: { email?: string; phone?: string } = {};

    // Try to find email
    const emailPatterns = [
      /[\w.-]+@[\w.-]+\.\w{2,}/g,
    ];

    const pageText = await page.textContent('body') || '';

    for (const pattern of emailPatterns) {
      const match = pageText.match(pattern);
      if (match) {
        // Filter out common non-dealer emails
        const email = match.find(e =>
          !e.includes('autotrader') &&
          !e.includes('google') &&
          !e.includes('facebook')
        );
        if (email) {
          result.email = email;
          break;
        }
      }
    }

    // Try to find phone number
    const phoneSelectors = [
      'a[href^="tel:"]',
      '.dealer-phone',
      '.phone-number',
      '[data-testid="dealer-phone"]',
    ];

    for (const selector of phoneSelectors) {
      const element = await page.$(selector);
      if (element) {
        const text = await element.textContent();
        const href = await element.getAttribute('href');
        const phone = href?.replace('tel:', '') || text;
        if (phone && phone.match(/[\d-()+ ]{10,}/)) {
          result.phone = phone.trim();
          break;
        }
      }
    }

    // Try extracting phone from page text
    if (!result.phone) {
      const phoneMatch = pageText.match(/(?:\+?1[-.\s]?)?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}/);
      if (phoneMatch) {
        result.phone = phoneMatch[0];
      }
    }

    return result;
  }

  private async handleModals(page: Page): Promise<void> {
    try {
      const closeButtons = [
        'button[aria-label="Close"]',
        '.modal-close',
        '[data-testid="modal-close"]',
        'button:has-text("No thanks")',
        'button:has-text("Maybe later")',
        'button:has-text("×")',
      ];

      for (const selector of closeButtons) {
        const button = await page.$(selector);
        if (button && await button.isVisible()) {
          await button.click();
          await randomDelay(500, 1000);
        }
      }

      // Accept cookies
      const cookieButton = await page.$('button:has-text("Accept"), #onetrust-accept-btn-handler');
      if (cookieButton && await cookieButton.isVisible()) {
        await cookieButton.click();
        await randomDelay(500, 1000);
      }
    } catch {
      // Modals might not appear
    }
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

/**
 * Generate contact message for a listing
 */
export function generateContactMessage(
  listing: Listing,
  template: 'inquiry' | 'carfax_request' | 'follow_up' = 'inquiry'
): string {
  const vehicle = `${listing.year} ${listing.make} ${listing.model}`;

  switch (template) {
    case 'inquiry':
      return `Hi, I'm interested in the ${vehicle} listed at $${listing.price?.toLocaleString() || 'your asking price'}.

Is this vehicle still available? I'm looking for a reliable family vehicle and would like to know:
- Can you share the CARFAX or vehicle history report?
- Are there any known issues or required repairs?
- What is the vehicle's service history?

I'm a serious buyer and can arrange to view the vehicle at your convenience.

Thank you.`;

    case 'carfax_request':
      return `Hi, I'm interested in the ${vehicle} you have listed.

Before scheduling a viewing, I would like to review the CARFAX or vehicle history report. Could you please share it?

Thank you.`;

    case 'follow_up':
      return `Hi, I'm following up on my inquiry about the ${vehicle}.

Is this vehicle still available? I remain interested and would appreciate any updates.

Thank you.`;

    default:
      return `Hi, I'm interested in the ${vehicle}. Is it still available?`;
  }
}
