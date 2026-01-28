import { Command } from 'commander';
import { getDatabase, type ListingStatus, type Listing } from '../../database/index.js';
import * as readline from 'readline';

function formatListingSummary(listing: Listing): string {
  const lines: string[] = [];

  // Header
  lines.push(`\n${'='.repeat(70)}`);
  lines.push(`#${listing.id}: ${listing.year} ${listing.make} ${listing.model}${listing.trim ? ` ${listing.trim}` : ''}`);
  lines.push('='.repeat(70));

  // Quick facts line
  const price = listing.price ? `$${listing.price.toLocaleString()}` : 'Price N/A';
  const mileage = listing.mileageKm ? `${listing.mileageKm.toLocaleString()} km` : 'Mileage N/A';
  const location = [listing.city, listing.province].filter(Boolean).join(', ') || 'Location N/A';
  lines.push(`${price} | ${mileage} | ${location}`);

  // Seller info
  const sellerType = listing.sellerType || 'Unknown';
  const sellerName = listing.sellerName || 'Unknown seller';
  lines.push(`Seller: ${sellerType} - ${sellerName}`);

  // Score if available
  if (listing.score !== null) {
    lines.push(`Score: ${listing.score}/100`);
  }

  // Red flags if any
  if (listing.redFlags && listing.redFlags.length > 0) {
    lines.push(`\nRed Flags:`);
    for (const flag of listing.redFlags.slice(0, 3)) {
      lines.push(`  - ${flag}`);
    }
    if (listing.redFlags.length > 3) {
      lines.push(`  ... and ${listing.redFlags.length - 3} more`);
    }
  }

  // AI summary if available
  if (listing.aiAnalysis) {
    try {
      const analysis = JSON.parse(listing.aiAnalysis);
      if (analysis.summary) {
        lines.push(`\nSummary: ${analysis.summary.slice(0, 200)}${analysis.summary.length > 200 ? '...' : ''}`);
      }
    } catch {}
  }

  // URL
  lines.push(`\nURL: ${listing.sourceUrl}`);

  return lines.join('\n');
}

function formatDetailedView(listing: Listing): string {
  const lines: string[] = [];

  lines.push(`\n${'='.repeat(70)}`);
  lines.push(`DETAILED VIEW: #${listing.id}`);
  lines.push('='.repeat(70));

  // Full description
  if (listing.description) {
    lines.push('\nDescription:');
    lines.push(listing.description);
  }

  // All red flags
  if (listing.redFlags && listing.redFlags.length > 0) {
    lines.push('\nAll Red Flags:');
    for (const flag of listing.redFlags) {
      lines.push(`  - ${flag}`);
    }
  }

  // AI analysis
  if (listing.aiAnalysis) {
    try {
      const analysis = JSON.parse(listing.aiAnalysis);

      if (analysis.positives?.length > 0) {
        lines.push('\nPositives:');
        for (const p of analysis.positives) {
          lines.push(`  + ${p}`);
        }
      }

      if (analysis.concerns?.length > 0) {
        lines.push('\nConcerns:');
        for (const c of analysis.concerns) {
          lines.push(`  ? ${c}`);
        }
      }

      if (analysis.deception) {
        const hasDeception =
          (analysis.deception.deceptiveLanguage?.length || 0) > 0 ||
          (analysis.deception.hiddenCosts?.length || 0) > 0;

        if (hasDeception) {
          lines.push('\nDeception Flags:');
          for (const d of analysis.deception.deceptiveLanguage || []) {
            lines.push(`  ! ${d}`);
          }
          for (const h of analysis.deception.hiddenCosts || []) {
            lines.push(`  $ ${h}`);
          }
        }
      }
    } catch {}
  }

  // CARFAX info if available
  if (listing.carfaxReceived) {
    lines.push('\nCARFAX:');
    lines.push(`  Accidents: ${listing.accidentCount ?? 'N/A'}`);
    lines.push(`  Owners: ${listing.ownerCount ?? 'N/A'}`);
    lines.push(`  Service Records: ${listing.serviceRecordCount ?? 'N/A'}`);
    if (listing.carfaxSummary) {
      lines.push(`  Summary: ${listing.carfaxSummary.slice(0, 300)}...`);
    }
  }

  // Features
  if (listing.features && listing.features.length > 0) {
    lines.push('\nFeatures:');
    lines.push(`  ${listing.features.join(', ')}`);
  }

  lines.push('');
  return lines.join('\n');
}

async function promptUser(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      resolve(answer.toLowerCase().trim());
    });
  });
}

export const triageCommand = new Command('triage')
  .description('Interactively triage new listings')
  .option('-l, --limit <number>', 'Maximum listings to show', '20')
  .option('-s, --status <status>', 'Filter by status (default: discovered)', 'discovered')
  .option('--min-score <number>', 'Only show listings with score >= value')
  .action(async (options) => {
    const db = getDatabase();

    // Get listings to triage
    const statusFilter = options.status.split(',') as ListingStatus[];
    let listings = db.listListings({
      status: statusFilter,
      limit: parseInt(options.limit, 10),
      orderBy: options.minScore ? 'score' : 'discovered',
    });

    // Apply min score filter if specified
    if (options.minScore) {
      const minScore = parseInt(options.minScore, 10);
      listings = listings.filter(l => (l.score ?? 0) >= minScore);
    }

    if (listings.length === 0) {
      console.log(`\nNo listings found with status: ${options.status}`);
      console.log('Run `carsearch search` to find vehicles, or use --status to filter differently.\n');
      return;
    }

    console.log(`\nFound ${listings.length} listings to triage`);
    console.log('Commands: [i]nteresting  [s]kip  [v]iew details  [n]ote  [q]uit\n');

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    let triaged = 0;
    let interesting = 0;
    let skipped = 0;

    for (const listing of listings) {
      console.log(formatListingSummary(listing));

      let decided = false;
      while (!decided) {
        const answer = await promptUser(rl, '\n[i/s/v/n/q]: ');

        switch (answer) {
          case 'i':
          case 'interesting':
            db.updateListing(listing.id, { status: 'analyzed' });
            console.log(`  -> Marked as ANALYZED (ready to contact)`);
            triaged++;
            interesting++;
            decided = true;
            break;

          case 's':
          case 'skip':
            db.updateListing(listing.id, { status: 'rejected' });
            console.log(`  -> Marked as REJECTED`);
            triaged++;
            skipped++;
            decided = true;
            break;

          case 'v':
          case 'view':
            console.log(formatDetailedView(listing));
            break;

          case 'n':
          case 'note':
            const note = await promptUser(rl, 'Enter note: ');
            if (note) {
              const existingNotes = listing.notes || '';
              const timestamp = new Date().toISOString().split('T')[0];
              const newNotes = existingNotes
                ? `${existingNotes}\n[${timestamp}] ${note}`
                : `[${timestamp}] ${note}`;
              db.updateListing(listing.id, { notes: newNotes });
              console.log(`  -> Note added`);
            }
            break;

          case 'q':
          case 'quit':
            console.log(`\n${'='.repeat(40)}`);
            console.log('Triage Summary:');
            console.log(`  Reviewed: ${triaged}`);
            console.log(`  Interesting: ${interesting}`);
            console.log(`  Skipped: ${skipped}`);
            console.log(`  Remaining: ${listings.length - triaged}`);
            console.log('='.repeat(40) + '\n');
            rl.close();
            return;

          default:
            console.log('  Unknown command. Use: [i]nteresting [s]kip [v]iew [n]ote [q]uit');
        }
      }
    }

    console.log(`\n${'='.repeat(40)}`);
    console.log('Triage Complete!');
    console.log(`  Total: ${triaged}`);
    console.log(`  Interesting: ${interesting}`);
    console.log(`  Skipped: ${skipped}`);
    console.log('='.repeat(40));
    console.log('\nNext steps:');
    console.log('  - Run `carsearch list --status analyzed` to see triaged/interesting listings');
    console.log('  - Run `carsearch export` to export interesting listings for analysis\n');

    rl.close();
  });
