/**
 * Debug script to test form submission on AutoTrader
 */
import { chromium } from 'playwright';
import { getEnv } from '../src/config.js';

const TEST_URL = process.argv[2] || 'https://www.autotrader.ca/a/dodge/grand%20caravan/markham/ontario/19_13244937_/';

async function testForm() {
  console.log('Testing form submission on:', TEST_URL);
  console.log('');

  const browser = await chromium.launch({
    headless: false,
    slowMo: 200,
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    locale: 'en-CA',
  });

  const page = await context.newPage();

  try {
    await page.goto(TEST_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    // Accept cookies if present
    const cookieBtn = await page.$('#onetrust-accept-btn-handler');
    if (cookieBtn && await cookieBtn.isVisible()) {
      console.log('Accepting cookies...');
      await cookieBtn.click();
      await page.waitForTimeout(1000);
    }

    // Log all forms on the page
    const forms = await page.$$('form');
    console.log(`Found ${forms.length} form(s) on page\n`);

    for (let i = 0; i < forms.length; i++) {
      const form = forms[i];
      const id = await form.getAttribute('id');
      const className = await form.getAttribute('class');
      const action = await form.getAttribute('action');
      console.log(`Form ${i + 1}: id="${id}" class="${className}" action="${action}"`);

      // List inputs in this form
      const inputs = await form.$$('input, textarea, button');
      for (const input of inputs) {
        const tag = await input.evaluate(el => el.tagName.toLowerCase());
        const type = await input.getAttribute('type');
        const name = await input.getAttribute('name');
        const placeholder = await input.getAttribute('placeholder');
        const text = tag === 'button' ? await input.textContent() : null;
        console.log(`  - ${tag}: type="${type}" name="${name}" placeholder="${placeholder}" ${text ? `text="${text}"` : ''}`);
      }
      console.log('');
    }

    // Now try to fill the lead form specifically
    console.log('\n--- Attempting to fill lead form ---\n');

    // Look for the lead/contact form
    const leadForm = await page.$('form[class*="LeadForm"], form[class*="lead"], .LeadForm');
    if (!leadForm) {
      console.log('Lead form not found by class, trying other selectors...');
    }

    // Try filling fields directly by common patterns
    const buyerName = getEnv('BUYER_NAME', false) || 'Test Buyer';
    const buyerEmail = getEnv('EMAIL_USER');
    const buyerPhone = getEnv('BUYER_PHONE', false);

    // Name field - try multiple selectors
    const nameSelectors = [
      'input[name="firstName"]',
      'input[name="name"]',
      'input[name*="name" i]',
      'input[placeholder*="Name" i]',
      'input[aria-label*="Name" i]',
      '#firstName',
      '#name',
    ];

    let nameFilled = false;
    for (const sel of nameSelectors) {
      const field = await page.$(sel);
      if (field && await field.isVisible()) {
        await field.fill(buyerName);
        console.log(`✓ Filled name with selector: ${sel}`);
        nameFilled = true;
        break;
      }
    }
    if (!nameFilled) {
      console.log('✗ Could not find name field');
    }

    // Email field
    const emailSelectors = [
      'input[type="email"]',
      'input[name="email"]',
      'input[name*="email" i]',
      'input[placeholder*="Email" i]',
      '#email',
    ];

    let emailFilled = false;
    for (const sel of emailSelectors) {
      const field = await page.$(sel);
      if (field && await field.isVisible()) {
        await field.fill(buyerEmail);
        console.log(`✓ Filled email with selector: ${sel}`);
        emailFilled = true;
        break;
      }
    }
    if (!emailFilled) {
      console.log('✗ Could not find email field');
    }

    // Phone field (optional)
    if (buyerPhone) {
      const phoneSelectors = [
        'input[type="tel"]',
        'input[name="phone"]',
        'input[name*="phone" i]',
        'input[placeholder*="Phone" i]',
        '#phone',
      ];

      for (const sel of phoneSelectors) {
        const field = await page.$(sel);
        if (field && await field.isVisible()) {
          await field.fill(buyerPhone);
          console.log(`✓ Filled phone with selector: ${sel}`);
          break;
        }
      }
    }

    // Message/textarea
    const messageSelectors = [
      'textarea[name="message"]',
      'textarea[name*="message" i]',
      'textarea[name*="comment" i]',
      'textarea[placeholder*="Message" i]',
      '.LeadForm textarea',
      'form textarea',
    ];

    let messageFilled = false;
    for (const sel of messageSelectors) {
      const field = await page.$(sel);
      if (field && await field.isVisible()) {
        const currentValue = await field.inputValue();
        console.log(`Found message field (${sel}), current value: "${currentValue.slice(0, 50)}..."`);
        // Don't overwrite if already filled
        if (!currentValue.trim()) {
          await field.fill('Is this vehicle still available? I am interested in viewing it.');
          console.log(`✓ Filled message`);
        } else {
          console.log(`✓ Message already has content, keeping it`);
        }
        messageFilled = true;
        break;
      }
    }
    if (!messageFilled) {
      console.log('✗ Could not find message field');
    }

    await page.waitForTimeout(1000);

    // Find submit button
    console.log('\n--- Looking for submit button ---\n');

    const submitSelectors = [
      'button[type="submit"]',
      'button:has-text("Send")',
      'button:has-text("Submit")',
      'input[type="submit"]',
      '.LeadForm button',
      'form button',
    ];

    let submitButton = null;
    for (const sel of submitSelectors) {
      const btn = await page.$(sel);
      if (btn && await btn.isVisible()) {
        const text = await btn.textContent();
        console.log(`Found button with selector "${sel}": "${text?.trim()}"`);
        submitButton = btn;
        break;
      }
    }

    if (!submitButton) {
      console.log('✗ Could not find submit button');
    }

    // Take screenshot before submit
    await page.screenshot({ path: '/tmp/form-filled.png', fullPage: false });
    console.log('\nScreenshot saved to /tmp/form-filled.png');

    // Ask before submitting
    console.log('\nForm is filled. Press Enter to submit (or Ctrl+C to cancel)...');
    await new Promise(resolve => process.stdin.once('data', resolve));

    if (submitButton) {
      console.log('Clicking submit...');
      await submitButton.click();
      await page.waitForTimeout(3000);

      // Check for success
      const pageContent = await page.textContent('body');
      if (pageContent?.toLowerCase().includes('thank you') ||
          pageContent?.toLowerCase().includes('message sent') ||
          pageContent?.toLowerCase().includes('submitted')) {
        console.log('✓ Success message detected!');
      } else {
        console.log('No obvious success message detected');
      }

      await page.screenshot({ path: '/tmp/form-submitted.png', fullPage: false });
      console.log('Screenshot saved to /tmp/form-submitted.png');
    }

    console.log('\nDone. Browser will close in 5 seconds...');
    await page.waitForTimeout(5000);

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await browser.close();
  }
}

testForm();
