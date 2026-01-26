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

    // Email field - REQUIRED
    const emailSelectors = [
      'input[type="email"]',
      'input[name*="email" i]',
      'input[name*="Email"]',
      'input[placeholder*="email" i]',
      'input[placeholder*="Email"]',
      'input[id*="email" i]',
      'input[autocomplete="email"]',
      '[data-testid*="email"] input',
      'input[aria-label*="email" i]',
    ];
    let emailFilled = false;
    for (const selector of emailSelectors) {
      try {
        const field = await page.$(selector);
        if (field && await field.isVisible()) {
          await field.fill(formData.email);
          console.log(`  Filled email: ${formData.email}`);
          emailFilled = true;
          break;
        }
      } catch {
        continue;
      }
    }
    if (!emailFilled) {
      console.log('  ⚠️ WARNING: Could not find email field!');
      // Debug: list all visible input fields
      const allInputs = await page.$$('input:visible');
      console.log(`  Debug: Found ${allInputs.length} visible input fields`);
      for (const input of allInputs.slice(0, 5)) {
        const type = await input.getAttribute('type');
        const name = await input.getAttribute('name');
        const placeholder = await input.getAttribute('placeholder');
        console.log(`    - type="${type}" name="${name}" placeholder="${placeholder}"`);
      }
    }

    // Phone field (optional but try to fill)
    let phoneFilled = false;
    if (formData.phone) {
      const phoneSelectors = [
        'input[type="tel"]',
        'input[name*="phone" i]',
        'input[name*="Phone"]',
        'input[placeholder*="phone" i]',
        'input[placeholder*="Phone"]',
        'input[id*="phone" i]',
        'input[autocomplete="tel"]',
        '[data-testid*="phone"] input',
      ];
      for (const selector of phoneSelectors) {
        try {
          const field = await page.$(selector);
          if (field && await field.isVisible()) {
            await field.fill(formData.phone);
            console.log(`  Filled phone: ${formData.phone}`);
            phoneFilled = true;
            break;
          }
        } catch {
          continue;
        }
      }
      if (!phoneFilled) {
        console.log('  Note: Could not find phone field (optional)');
      }
    }

    // Message field - REQUIRED
    const messageSelectors = [
      'textarea[name*="message" i]',
      'textarea[name*="comment" i]',
      'textarea[placeholder*="message" i]',
      'textarea[id*="message" i]',
      'textarea[aria-label*="message" i]',
      'textarea',  // Last resort: any textarea
    ];
    let messageFilled = false;
    for (const selector of messageSelectors) {
      try {
        const field = await page.$(selector);
        if (field && await field.isVisible()) {
          await field.fill(formData.message);
          console.log(`  Filled message: ${formData.message.slice(0, 50)}...`);
          messageFilled = true;
          break;
        }
      } catch {
        continue;
      }
    }
    if (!messageFilled) {
      console.log('  ⚠️ WARNING: Could not find message field!');
    }

    // Check if required fields were filled - ABORT if not
    if (!nameFilled || !emailFilled) {
      console.log('\n❌ ABORTING: Required fields not filled (need at least name and email)');
      return {
        success: false,
        method: 'web_form',
        message: `Missing required fields: ${!nameFilled ? 'name ' : ''}${!emailFilled ? 'email' : ''}`.trim(),
      };
    }

    // Uncheck all marketing/spam checkboxes aggressively
    // AutoTrader and other sites often have pre-checked newsletter/alert options
    console.log('  Checking for spam/marketing checkboxes...');

    const spamPatterns = [
      'price alert', 'similar listing', 'newsletter', 'subscribe',
      'marketing', 'get alert', 'email me', 'notify me', 'send me',
      'keep me', 'stay updated', 'updates about'
    ];

    // Method 1: Find ALL checked checkboxes and uncheck if near spam-related text
    try {
      const allCheckboxes = await page.$$('input[type="checkbox"]');
      for (const checkbox of allCheckboxes) {
        try {
          const isChecked = await checkbox.isChecked();
          if (!isChecked) continue;

          // Get surrounding text to check if it's spam-related
          const surroundingText = await checkbox.evaluate(el => {
            const label = el.closest('label') || el.parentElement;
            return (label?.textContent || '').toLowerCase();
          });

          const isSpam = spamPatterns.some(p => surroundingText.includes(p));
          if (isSpam) {
            await checkbox.uncheck();
            console.log('  ✓ Unchecked spam checkbox: ' + surroundingText.trim().slice(0, 40));
          }
        } catch {
          continue;
        }
      }
    } catch (e) {
      // Ignore checkbox errors
    }

    // Method 2: Find labels with spam text and uncheck their checkboxes
    try {
      const allLabels = await page.$$('label');
      for (const label of allLabels) {
        try {
          const text = (await label.textContent())?.toLowerCase() || '';
          if (!await label.isVisible()) continue;

          const isSpam = spamPatterns.some(p => text.includes(p));
          if (isSpam) {
            const checkbox = await label.$('input[type="checkbox"]');
            if (checkbox && await checkbox.isChecked()) {
              // Try direct uncheck first, then click label as fallback
              try {
                await checkbox.uncheck();
              } catch {
                await label.click();
              }
              console.log('  ✓ Unchecked via label: ' + text.trim().slice(0, 40));
            }
          }
        } catch {
          continue;
        }
      }
    } catch (e) {
      // Ignore label errors
    }

    // Method 3: Use Playwright's locator to find and uncheck any remaining checked spam checkboxes
    for (const pattern of spamPatterns) {
      try {
        const locator = page.locator(`text=${pattern}`).locator('xpath=ancestor::label//input[type="checkbox"]');
        const count = await locator.count();
        for (let i = 0; i < count; i++) {
          const checkbox = locator.nth(i);
          if (await checkbox.isChecked()) {
            await checkbox.uncheck({ force: true });
            console.log(`  ✓ Unchecked via locator: ${pattern}`);
          }
        }
      } catch {
        // Pattern not found or not a checkbox, continue
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

    // Take screenshot after submission for verification
    const screenshotPath = `/tmp/contact-form-${Date.now()}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: false });
    console.log(`  📸 Post-submit screenshot: ${screenshotPath}`);

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
        console.log('✅ Form submitted successfully!');
        return {
          success: true,
          method: 'web_form',
          message: 'Contact form submitted successfully',
          screenshotPath,
        };
      }
    }

    // Check for error messages
    const errorPatterns = [
      /please (fill|enter|provide)/i,
      /required field/i,
      /invalid (email|phone)/i,
      /error/i,
    ];

    for (const pattern of errorPatterns) {
      if (pattern.test(pageContent)) {
        console.log('❌ Form submission failed - error detected on page');
        return {
          success: false,
          method: 'web_form',
          message: 'Form submission failed - validation error on page',
          screenshotPath,
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
        screenshotPath,
      };
    }

    // If we got here, form might have submitted but no clear indicator
    console.log('⚠️ Form clicked but no clear success/failure indicator');
    return {
      success: true,
      method: 'web_form',
      message: 'Form submitted (no confirmation detected) - check screenshot',
      screenshotPath,
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
