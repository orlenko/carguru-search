/**
 * Test contact form submission on a single listing
 */
import { WebFormContact, generateContactMessage } from '../src/contact/web-form.js';
import { getEnv } from '../src/config.js';
import type { Listing } from '../src/database/client.js';

const DRY_RUN = process.argv.includes('--dry-run');
// Find URL argument (starts with http)
const urlArg = process.argv.find(a => a.startsWith('http'));
const TEST_URL = urlArg || 'https://www.autotrader.ca/a/dodge/grand%20caravan/markham/ontario/19_13244937_/';

async function test() {
  console.log('Testing contact form on:', TEST_URL);
  console.log('Mode:', DRY_RUN ? 'DRY RUN' : 'LIVE (will submit)');
  console.log('');

  // Create a mock listing
  const listing: Listing = {
    id: 999,
    sourceUrl: TEST_URL,
    source: 'autotrader',
    make: 'Dodge',
    model: 'Grand Caravan',
    year: 2016,
    price: 12500,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const buyerName = getEnv('BUYER_NAME', false) || 'Test Buyer';
  const buyerEmail = getEnv('EMAIL_USER');
  const buyerPhone = getEnv('BUYER_PHONE', false);

  console.log('Contact info:');
  console.log('  Name:', buyerName);
  console.log('  Email:', buyerEmail);
  console.log('  Phone:', buyerPhone || '(not set)');
  console.log('');

  const message = generateContactMessage(listing, 'inquiry');
  console.log('Message:', message.slice(0, 100) + '...');
  console.log('');

  const webContact = new WebFormContact();

  try {
    const result = await webContact.contactViaAutoTrader(
      listing,
      {
        name: buyerName,
        email: buyerEmail,
        phone: buyerPhone,
        message,
      },
      { headless: false, dryRun: DRY_RUN }
    );

    console.log('');
    console.log('Result:');
    console.log('  Success:', result.success);
    console.log('  Method:', result.method);
    console.log('  Message:', result.message);
    if (result.dealerEmail) console.log('  Dealer Email:', result.dealerEmail);
    if (result.dealerPhone) console.log('  Dealer Phone:', result.dealerPhone);
    if (result.screenshotPath) console.log('  Screenshot:', result.screenshotPath);

  } catch (error) {
    console.error('Error:', error);
  }
}

test();
