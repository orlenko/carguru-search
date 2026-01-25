/**
 * Reset contacted listings back to "new" status
 */
import { getDatabase } from '../src/database/index.js';

const db = getDatabase();

// Get all contacted listings
const contacted = db.listListings({ status: 'contacted', limit: 100 });

console.log(`Resetting ${contacted.length} contacted listings to "new"...\n`);

for (const listing of contacted) {
  db.updateListing(listing.id, {
    status: 'new',
    contactAttempts: 0,
    lastContactedAt: null as any,
  });
  console.log(`  Reset #${listing.id}: ${listing.year} ${listing.make} ${listing.model}`);
}

console.log('\nDone.');
