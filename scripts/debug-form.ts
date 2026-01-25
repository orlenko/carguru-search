/**
 * Debug form buttons on AutoTrader
 */
import { chromium } from 'playwright';

const TEST_URL = 'https://www.autotrader.ca/a/dodge/grand%20caravan/markham/ontario/19_13244937_/';

async function debug() {
  const browser = await chromium.launch({ headless: false, slowMo: 100 });
  const page = await browser.newPage();

  await page.goto(TEST_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  // Accept cookies
  try {
    const cookieBtn = await page.$('#onetrust-accept-btn-handler');
    if (cookieBtn && await cookieBtn.isVisible()) {
      await cookieBtn.click();
      await page.waitForTimeout(1000);
    }
  } catch {}

  console.log('\n=== ALL BUTTONS ON PAGE ===\n');

  const buttons = await page.$$('button');
  for (let i = 0; i < buttons.length; i++) {
    const btn = buttons[i];
    const text = await btn.textContent();
    const type = await btn.getAttribute('type');
    const className = await btn.getAttribute('class');
    const isVisible = await btn.isVisible();
    console.log(`Button ${i + 1}: "${text?.trim()}" type="${type}" class="${className?.slice(0, 50)}" visible=${isVisible}`);
  }

  console.log('\n=== FORMS ON PAGE ===\n');

  const forms = await page.$$('form');
  for (let i = 0; i < forms.length; i++) {
    const form = forms[i];
    const className = await form.getAttribute('class');
    const id = await form.getAttribute('id');
    console.log(`Form ${i + 1}: id="${id}" class="${className}"`);

    const formButtons = await form.$$('button');
    for (const btn of formButtons) {
      const text = await btn.textContent();
      const type = await btn.getAttribute('type');
      const isVisible = await btn.isVisible();
      console.log(`  - Button: "${text?.trim()}" type="${type}" visible=${isVisible}`);
    }
  }

  console.log('\n=== TESTING SPECIFIC SELECTORS ===\n');

  const selectors = [
    'button:has-text("Send")',
    'button[type="submit"]',
    'form[class*="lead"] button',
    'form button',
    '.LeadForm button',
    '[class*="LeadForm"] button',
  ];

  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        const text = await el.textContent();
        const visible = await el.isVisible();
        console.log(`"${sel}" -> Found: "${text?.trim()}" visible=${visible}`);
      } else {
        console.log(`"${sel}" -> NOT FOUND`);
      }
    } catch (e: any) {
      console.log(`"${sel}" -> ERROR: ${e.message}`);
    }
  }

  console.log('\nBrowser open for inspection. Press Ctrl+C to close.');
  await page.waitForTimeout(60000);
  await browser.close();
}

debug();
