import { Command } from 'commander';
import { getDatabase, type ListingStatus } from '../../database/index.js';

export const listCommand = new Command('list')
  .description('List discovered vehicles')
  .option('-s, --status <status>', 'Filter by status (new, shortlisted, rejected, etc.)')
  .option('--source <source>', 'Filter by source (cargurus, autotrader)')
  .option('-n, --limit <number>', 'Limit number of results', '20')
  .option('--order <field>', 'Order by field (score, price, mileage, discovered)', 'discovered')
  .action(async (options) => {
    try {
      const db = getDatabase();

      const listings = db.listListings({
        status: options.status as ListingStatus | undefined,
        source: options.source,
        limit: parseInt(options.limit, 10),
        orderBy: options.order as 'score' | 'price' | 'mileage' | 'discovered',
      });

      if (listings.length === 0) {
        console.log('\nNo listings found. Run `carsearch search` to find vehicles.\n');
        return;
      }

      console.log(`\n${'ID'.padStart(4)} | ${'Year'.padEnd(4)} | ${'Model'.padEnd(25)} | ${'Price'.padStart(10)} | ${'Mileage'.padStart(12)} | ${'Status'.padEnd(12)} | Location`);
      console.log('-'.repeat(100));

      for (const listing of listings) {
        const model = `${listing.make} ${listing.model}`.slice(0, 25);
        const price = listing.price ? `$${listing.price.toLocaleString()}` : 'N/A';
        const mileage = listing.mileageKm ? `${listing.mileageKm.toLocaleString()} km` : 'N/A';
        const location = [listing.city, listing.province].filter(Boolean).join(', ') || 'N/A';

        console.log(
          `${listing.id.toString().padStart(4)} | ` +
          `${listing.year.toString().padEnd(4)} | ` +
          `${model.padEnd(25)} | ` +
          `${price.padStart(10)} | ` +
          `${mileage.padStart(12)} | ` +
          `${listing.status.padEnd(12)} | ` +
          `${location}`
        );
      }

      console.log(`\nShowing ${listings.length} listings. Use --limit to see more.\n`);
      console.log('Run `carsearch show <id>` to see details for a specific listing.');
    } catch (error) {
      console.error('Error listing vehicles:', error);
      process.exit(1);
    }
  });
