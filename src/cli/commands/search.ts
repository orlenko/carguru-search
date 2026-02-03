import { Command } from 'commander';
import { loadConfig } from '../../config.js';
import { getDatabase } from '../../database/index.js';
import { AutoTraderScraper } from '../../scrapers/autotrader.js';

function parseIntOption(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return parsed;
}

export const searchCommand = new Command('search')
  .description('Search for vehicles matching your criteria')
  .option('--dry-run', 'Show what would be searched without saving')
  .option('--headless', 'Run browser in headless mode (may trigger bot detection)')
  .option('--slow-mo <ms>', 'Slow down browser actions by this many ms', '50')
  .option('--make <make>', 'Override make from config')
  .option('--model <model>', 'Override model from config')
  .option('--year-min <year>', 'Override minimum year from config')
  .option('--year-max <year>', 'Override maximum year from config')
  .option('--price-max <price>', 'Override maximum price from config')
  .option('--mileage-max <km>', 'Override maximum mileage (km) from config')
  .option('--postal-code <code>', 'Override postal code from config')
  .option('--radius-km <km>', 'Override search radius (km) from config')
  .action(async (options) => {
    try {
      const config = loadConfig();
      const db = getDatabase();
      const search = {
        ...config.search,
        ...(options.make ? { make: options.make } : {}),
        ...(options.model ? { model: options.model } : {}),
        ...(options.yearMin ? { yearMin: parseIntOption(options.yearMin, 'year-min') } : {}),
        ...(options.yearMax ? { yearMax: parseIntOption(options.yearMax, 'year-max') } : {}),
        ...(options.priceMax ? { priceMax: parseIntOption(options.priceMax, 'price-max') } : {}),
        ...(options.mileageMax ? { mileageMax: parseIntOption(options.mileageMax, 'mileage-max') } : {}),
        ...(options.postalCode ? { postalCode: options.postalCode } : {}),
        ...(options.radiusKm ? { radiusKm: parseIntOption(options.radiusKm, 'radius-km') } : {}),
      };

      console.log('\n🔍 Starting vehicle search...\n');
      console.log(`Make: ${search.make}`);
      console.log(`Model: ${search.model}`);
      console.log(`Year: ${search.yearMin || 'any'} - ${search.yearMax || 'any'}`);
      console.log(`Max mileage: ${search.mileageMax ? `${search.mileageMax.toLocaleString()} km` : 'any'}`);
      console.log(`Max price: ${search.priceMax ? `$${search.priceMax.toLocaleString()}` : 'any'}`);
      console.log(`Location: ${search.postalCode} (${search.radiusKm} km radius)`);
      console.log('');

      const runId = db.startSearchRun('autotrader', search);
      const scraperOptions = {
        headless: options.headless || false,
        slowMo: parseInt(options.slowMo, 10),
      };
      const scraper = new AutoTraderScraper(scraperOptions);

      try {
        const result = await scraper.search(search);

        const totalDisplay = result.totalFound > 0 ? `${result.totalFound} total, ` : '';
        console.log(`\nFound ${totalDisplay}${result.listings.length} listings scraped (${result.pagesFetched} pages)`);

        let newCount = 0;
        let updatedCount = 0;

        if (!options.dryRun) {
          for (const listing of result.listings) {
            const existing = db.getListingBySourceId(listing.source, listing.sourceId);
            if (existing) {
              // Check if price changed
              if (existing.price !== listing.price && listing.price) {
                db.recordPriceChange(existing.id, listing.price);
                updatedCount++;
              }
              // Always upsert to update description, features, photos, etc.
              db.upsertListing(listing);
            } else {
              db.upsertListing(listing);
              newCount++;
            }
          }

          db.completeSearchRun(runId, result.listings.length, newCount);

          console.log(`\nResults:`);
          console.log(`  New listings: ${newCount}`);
          console.log(`  Updated: ${updatedCount}`);
          console.log(`  Already known: ${result.listings.length - newCount - updatedCount}`);
        } else {
          console.log('\n[Dry run - no listings saved]');
          console.log('\nSample listings:');
          for (const listing of result.listings.slice(0, 5)) {
            console.log(`  ${listing.year} ${listing.make} ${listing.model} - $${listing.price?.toLocaleString() || '?'} - ${listing.mileageKm?.toLocaleString() || '?'} km`);
          }
        }

        console.log('\nRun `carsearch list` to see all listings.');
      } catch (error) {
        db.failSearchRun(runId, String(error));
        throw error;
      }
    } catch (error) {
      console.error('Search failed:', error);
      process.exit(1);
    }
  });
