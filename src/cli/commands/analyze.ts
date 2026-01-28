import { Command } from 'commander';
import { getDatabase, type ListingStatus } from '../../database/index.js';
import { analyzeListingWithClaude, type ListingAnalysis } from '../../analyzers/listing-analyzer.js';

export const analyzeCommand = new Command('analyze')
  .description('Analyze listings using AI to detect red flags and assess quality')
  .argument('[id]', 'Specific listing ID to analyze (or "all" for unanalyzed listings)')
  .option('-f, --force', 'Re-analyze even if already analyzed')
  .option('--status <status>', 'Only analyze listings with this status', 'discovered')
  .option('-n, --limit <number>', 'Limit number of listings to analyze', '10')
  .action(async (id, options) => {
    try {
      const db = getDatabase();

      let listings;

      if (id && id !== 'all') {
        // Analyze specific listing
        const listing = db.getListing(parseInt(id, 10));
        if (!listing) {
          console.error(`Listing #${id} not found`);
          process.exit(1);
        }

        if (listing.aiAnalysis && !options.force) {
          console.log(`Listing #${id} already analyzed. Use --force to re-analyze.\n`);
          displayAnalysis(listing.id, JSON.parse(listing.aiAnalysis));
          return;
        }

        listings = [listing];
      } else {
        // Get listings to analyze
        listings = db.listListings({
          status: options.status as ListingStatus,
          limit: parseInt(options.limit, 10),
        });

        if (!options.force) {
          // Filter out already analyzed
          listings = listings.filter(l => !l.aiAnalysis);
        }

        if (listings.length === 0) {
          console.log('No listings to analyze. Use --force to re-analyze existing.');
          return;
        }
      }

      console.log(`\n🔍 Analyzing ${listings.length} listing(s)...\n`);

      for (let i = 0; i < listings.length; i++) {
        const listing = listings[i];
        console.log(`[${i + 1}/${listings.length}] Analyzing #${listing.id}: ${listing.year} ${listing.make} ${listing.model}...`);

        try {
          const analysis = await analyzeListingWithClaude(listing);

          // Save to database
          db.updateListing(listing.id, {
            aiAnalysis: JSON.stringify(analysis),
            score: analysis.recommendationScore,
            redFlags: analysis.redFlags,
          });

          displayAnalysis(listing.id, analysis);

          // Rate limiting
          if (i < listings.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        } catch (error) {
          console.error(`  ❌ Failed: ${error}`);
        }
      }

      console.log('\n✅ Analysis complete. Run `carsearch rank` to see ranked results.');
    } catch (error) {
      console.error('Analysis failed:', error);
      process.exit(1);
    }
  });

function displayAnalysis(id: number, analysis: ListingAnalysis): void {
  console.log(`\n  📊 Listing #${id} Analysis:`);
  console.log(`  Score: ${analysis.recommendationScore}/100 | Condition: ${analysis.estimatedCondition}`);

  if (analysis.redFlags.length > 0) {
    console.log(`  🚩 Red Flags:`);
    for (const flag of analysis.redFlags) {
      console.log(`     - ${flag}`);
    }
  }

  if (analysis.positives.length > 0) {
    console.log(`  ✅ Positives:`);
    for (const pos of analysis.positives.slice(0, 3)) {
      console.log(`     + ${pos}`);
    }
  }

  if (analysis.concerns.length > 0) {
    console.log(`  ⚠️  Verify:`);
    for (const concern of analysis.concerns.slice(0, 3)) {
      console.log(`     ? ${concern}`);
    }
  }

  console.log(`  💬 ${analysis.summary}`);
  console.log('');
}
