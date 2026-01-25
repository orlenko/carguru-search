/**
 * Debug checkbox detection on AutoTrader
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

  console.log('\n=== ALL CHECKBOXES ON PAGE ===\n');

  const allCheckboxes = await page.$$('input[type="checkbox"]');
  console.log(`Found ${allCheckboxes.length} checkboxes\n`);

  for (let i = 0; i < allCheckboxes.length; i++) {
    const checkbox = allCheckboxes[i];
    try {
      const visible = await checkbox.isVisible();
      const checked = await checkbox.isChecked();
      const id = await checkbox.getAttribute('id');
      const name = await checkbox.getAttribute('name');

      // Get label text
      const labelText = await checkbox.evaluate((el) => {
        const id = (el as any).id;
        if (id) {
          const label = (el as any).ownerDocument.querySelector(`label[for="${id}"]`);
          if (label) return `label[for]: ${label.textContent}`;
        }
        const parentLabel = (el as any).closest('label');
        if (parentLabel) return `parent label: ${parentLabel.textContent}`;
        const parent = (el as any).parentElement;
        return `parent: ${parent?.textContent?.slice(0, 100)}`;
      });

      console.log(`Checkbox ${i + 1}:`);
      console.log(`  id="${id}" name="${name}"`);
      console.log(`  visible=${visible} checked=${checked}`);
      console.log(`  ${labelText?.trim().slice(0, 80)}`);
      console.log('');
    } catch (e: any) {
      console.log(`Checkbox ${i + 1}: Error - ${e.message}`);
    }
  }

  console.log('\nLooking for the price alerts checkbox specifically...');

  // Try to scroll to make sure form is visible
  await page.evaluate(() => window.scrollTo(0, 500));
  await page.waitForTimeout(1000);

  const priceAlertCheckbox = await page.$('input[type="checkbox"]:has(+ *:text-matches("price|alert|similar", "i"))');
  if (priceAlertCheckbox) {
    console.log('Found with sibling selector');
  }

  console.log('\nBrowser open for inspection. Press Ctrl+C to close.');
  await page.waitForTimeout(60000);
  await browser.close();
}

debug();
