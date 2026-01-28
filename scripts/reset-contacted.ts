/**
 * Reset contacted listings back to "discovered" status
 */
import { getDatabase } from '../src/database/index.js';

const db = getDatabase();

// Get all contacted listings
const contacted = db.listListings({ status: 'contacted', limit: 100 });

console.log(`Resetting ${contacted.length} contacted listings to "discovered"...\n`);

for (const listing of contacted) {
  db.updateListing(listing.id, {
    status: 'discovered',
    contactAttempts: 0,
    lastContactedAt: null as any,
  });
  console.log(`  Reset #${listing.id}: ${listing.year} ${listing.make} ${listing.model}`);
}

console.log('\nDone.');
