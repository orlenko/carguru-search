import { Command } from 'commander';
import { loadConfig } from '../../config.js';
import { getDatabase } from '../../database/index.js';
import { CarGurusScraper } from '../../scrapers/cargurus.js';
import { AutoTraderScraper } from '../../scrapers/autotrader.js';

export const searchCommand = new Command('search')
  .description('Search for vehicles matching your criteria')
  .option('-s, --source <source>', 'Source to search (autotrader, cargurus)', 'autotrader')
  .option('--dry-run', 'Show what would be searched without saving')
  .option('--headless', 'Run browser in headless mode (may trigger bot detection)')
  .option('--slow-mo <ms>', 'Slow down browser actions by this many ms', '50')
  .action(async (options) => {
    try {
      const config = loadConfig();
      const db = getDatabase();

      console.log('\n🔍 Starting vehicle search...\n');
      console.log(`Make: ${config.search.make}`);
      console.log(`Model: ${config.search.model}`);
      console.log(`Year: ${config.search.yearMin || 'any'} - ${config.search.yearMax || 'any'}`);
      console.log(`Max mileage: ${config.search.mileageMax ? `${config.search.mileageMax.toLocaleString()} km` : 'any'}`);
      console.log(`Max price: ${config.search.priceMax ? `$${config.search.priceMax.toLocaleString()}` : 'any'}`);
      console.log(`Location: ${config.search.postalCode} (${config.search.radiusKm} km radius)`);
      console.log('');

      const runId = db.startSearchRun(options.source, config.search);

      let scraper;
      const scraperOptions = {
        headless: options.headless || false,
        slowMo: parseInt(options.slowMo, 10),
      };

      switch (options.source) {
        case 'cargurus':
          scraper = new CarGurusScraper(scraperOptions);
          break;
        case 'autotrader':
          scraper = new AutoTraderScraper(scraperOptions);
          break;
        default:
          console.error(`Unknown source: ${options.source}. Available: cargurus, autotrader`);
          process.exit(1);
      }

      try {
        const result = await scraper.search(config.search);

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
