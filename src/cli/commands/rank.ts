import { Command } from 'commander';
import { loadConfig } from '../../config.js';
import { getDatabase } from '../../database/index.js';
import { rankListings } from '../../ranking/scorer.js';
import { calculateTotalCost, parseTrimLevel } from '../../pricing/calculator.js';
import type { ListingAnalysis } from '../../analyzers/listing-analyzer.js';

export const rankCommand = new Command('rank')
  .description('Rank all analyzed listings by score')
  .option('-n, --limit <number>', 'Number of top listings to show', '20')
  .option('--all', 'Show all listings including rejected')
  .option('--min-score <score>', 'Minimum score to display', '0')
  .action(async (options) => {
    try {
      const config = loadConfig();
      const db = getDatabase();

      // Get all listings
      const listings = db.listListings({ limit: 1000 });

      if (listings.length === 0) {
        console.log('No listings found. Run `carsearch search` first.');
        return;
      }

      // Build analysis map from stored data
      const analyses = new Map<number, ListingAnalysis>();
      for (const listing of listings) {
        if (listing.aiAnalysis) {
          try {
            analyses.set(listing.id, JSON.parse(listing.aiAnalysis));
          } catch {
            // Invalid JSON, skip
          }
        }
      }

      const analyzedCount = analyses.size;
      if (analyzedCount === 0) {
        console.log('No listings have been analyzed yet.');
        console.log('Run `carsearch analyze all` to analyze listings with AI.\n');
      } else {
        console.log(`\n📊 ${analyzedCount}/${listings.length} listings analyzed\n`);
      }

      // Rank listings
      const ranked = rankListings(listings, analyses, config.scoring);

      // Filter and limit
      let filtered = ranked;
      const minScore = parseInt(options.minScore, 10);

      if (!options.all) {
        filtered = ranked.filter(r => r.score.passed && r.score.totalScore >= minScore);
      }

      const limit = parseInt(options.limit, 10);
      const toShow = filtered.slice(0, limit);

      if (toShow.length === 0) {
        console.log('No listings match the criteria.');
        return;
      }

      // Column widths (content only, not including separators)
      const cols = { rank: 4, score: 5, total: 11, mileage: 10, year: 4, trim: 10, location: 12 };
      const budget = config.search.priceMax || 18000;

      // Display ranked results
      const header = ` ${'RANK'.padStart(cols.rank)} │ ${'SCORE'.padStart(cols.score)} │ ${'TOTAL EST'.padStart(cols.total)} │ ${'MILEAGE'.padStart(cols.mileage)} │ ${'YEAR'.padStart(cols.year)} │ ${'TRIM'.padEnd(cols.trim)} │ ${'LOCATION'.padEnd(cols.location)} │ STATUS`;
      console.log('═'.repeat(header.length));
      console.log(header);
      console.log('═'.repeat(header.length));

      for (let i = 0; i < toShow.length; i++) {
        const { listing, score } = toShow[i];
        const analysis = analyses.get(listing.id);

        // Calculate total cost
        const isDealer = listing.sellerType === 'dealer';
        const costBreakdown = listing.price
          ? calculateTotalCost(listing.price, analysis?.pricing || null, budget, isDealer)
          : null;

        // Parse trim level from model/trim/description
        const titleText = `${listing.year} ${listing.make} ${listing.model} ${listing.trim || ''}`;
        const trimInfo = parseTrimLevel(titleText, listing.description || '');
        const trimDisplay = analysis?.detectedTrim || trimInfo?.trim || '?';
        const trimShort = trimDisplay.replace('Canada Value Package', 'CVP').slice(0, cols.trim);
        const trimUpgrade = trimInfo && trimInfo.rank >= 4 ? '⬆️' : '';

        const rank = (i + 1).toString().padStart(cols.rank);
        const scoreStr = (score.passed ? score.totalScore.toString() : '✗').padStart(cols.score);

        // Show total cost with budget indicator
        let totalStr = 'N/A'.padStart(cols.total);
        if (costBreakdown) {
          const totalRounded = Math.round(costBreakdown.totalCost / 100) * 100;
          const totalFormatted = `$${totalRounded.toLocaleString()}`;
          if (!costBreakdown.withinBudget) {
            totalStr = (totalFormatted + '⚠️').padStart(cols.total + 1); // emoji is 2 chars wide
          } else {
            totalStr = totalFormatted.padStart(cols.total);
          }
        }

        const mileage = (listing.mileageKm ? `${Math.round(listing.mileageKm / 1000)}k km` : 'N/A').padStart(cols.mileage);
        const year = listing.year.toString().padStart(cols.year);
        const trim = (trimShort + trimUpgrade).padEnd(cols.trim);
        const location = `${listing.city || '?'}`.slice(0, cols.location).padEnd(cols.location);

        // Status indicator
        let status = '';
        if (!score.passed) {
          status = '🚫 ' + (score.dealBreakers[0]?.slice(0, 15) || 'Rejected');
        } else if (score.totalScore >= 70) {
          status = '⭐ Strong';
        } else if (score.totalScore >= 50) {
          status = '👍 Check';
        } else {
          status = '🤔 Verify';
        }

        console.log(` ${rank} │ ${scoreStr} │ ${totalStr} │ ${mileage} │ ${year} │ ${trim} │ ${location} │ ${status}`);

        // Show clickable ID on second line
        const idLabel = `#${listing.id}`;
        const listedPrice = listing.price ? `listed $${listing.price.toLocaleString()}` : '';
        const idText = idLabel.padEnd(cols.total);
        const priceText = listedPrice.padStart(cols.mileage);
        const clickableId = listing.sourceUrl
          ? `\x1b]8;;${listing.sourceUrl}\x07${idText}\x1b]8;;\x07`
          : idText;
        const emptyRank = ''.padStart(cols.rank);
        const emptyScore = ''.padStart(cols.score);
        const emptyYear = ''.padStart(cols.year);
        const emptyTrim = ''.padStart(cols.trim);
        const emptyLoc = ''.padStart(cols.location);
        console.log(` ${emptyRank} │ ${emptyScore} │ ${clickableId} │ ${priceText} │ ${emptyYear} │ ${emptyTrim} │ ${emptyLoc} │`);
      }

      console.log('═'.repeat(header.length));
      console.log(`\nShowing top ${toShow.length} of ${filtered.length} listings.`);

      if (analyzedCount < listings.length) {
        console.log(`\n💡 Tip: Run \`carsearch analyze all\` to analyze remaining ${listings.length - analyzedCount} listings.`);
      }

      console.log('\nUse `carsearch show <id>` for details on a specific listing.');
    } catch (error) {
      console.error('Ranking failed:', error);
      process.exit(1);
    }
  });
