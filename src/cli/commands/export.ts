import { Command } from 'commander';
import { getDatabase, type Listing } from '../../database/index.js';
import * as fs from 'fs';
import * as path from 'path';

const EXPORT_DIR = 'export';
const CURRENT_BATCH = 'current-batch';

interface ExportOptions {
  status: string;
  minInfo: string;
  force: string;
  newBatch: boolean;
}

/**
 * Calculate info readiness percentage for a listing
 */
function calculateInfoReadiness(listing: Listing): number {
  let score = 0;

  // Has CARFAX (40%)
  if (listing.carfaxReceived) {
    score += 40;
  }

  // Has seller response - check conversation or contact attempts > 0 and status indicates response
  if (listing.sellerConversation && listing.sellerConversation.some(m => m.direction === 'inbound')) {
    score += 30;
  } else if (listing.status === 'carfax_received' || listing.status === 'analyzed') {
    score += 15; // Partial credit for progress
  }

  // Has AI analysis (20%)
  if (listing.aiAnalysis) {
    score += 20;
  }

  // Has price (10%)
  if (listing.price) {
    score += 10;
  }

  return score;
}

/**
 * Generate a safe folder name from listing details
 */
function generateFolderName(index: number, listing: Listing): string {
  const paddedIndex = String(index).padStart(3, '0');
  const year = listing.year;
  const model = `${listing.make}-${listing.model}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 30);
  const price = listing.price ? listing.price.toString() : 'na';

  return `${paddedIndex}-${year}-${model}-${price}`;
}

/**
 * Generate listing.md content
 */
function generateListingMarkdown(listing: Listing): string {
  const lines: string[] = [];

  // Title
  const title = `${listing.year} ${listing.make} ${listing.model}${listing.trim ? ` ${listing.trim}` : ''}`;
  const price = listing.price ? `$${listing.price.toLocaleString()}` : 'Price TBD';
  lines.push(`# ${title} - ${price}\n`);

  // Quick Facts
  lines.push('## Quick Facts');
  lines.push(`- **Price:** ${price}`);
  lines.push(`- **Mileage:** ${listing.mileageKm ? `${listing.mileageKm.toLocaleString()} km` : 'N/A'}`);
  lines.push(`- **Location:** ${[listing.city, listing.province].filter(Boolean).join(', ') || 'N/A'}`);
  lines.push(`- **Seller:** ${listing.sellerType || 'Unknown'} - ${listing.sellerName || 'Unknown'}`);
  lines.push(`- **Score:** ${listing.score !== null ? `${listing.score}/100` : 'Not scored'}`);
  if (listing.vin) {
    lines.push(`- **VIN:** ${listing.vin}`);
  }
  lines.push('');

  // CARFAX Summary if available
  if (listing.carfaxReceived) {
    lines.push('## CARFAX Summary');
    lines.push(`- **Accidents:** ${listing.accidentCount ?? 'N/A'}`);
    lines.push(`- **Owners:** ${listing.ownerCount ?? 'N/A'}`);
    lines.push(`- **Service Records:** ${listing.serviceRecordCount ?? 'N/A'}`);
    if (listing.carfaxSummary) {
      lines.push(`\n${listing.carfaxSummary}`);
    }
    lines.push('');
  }

  // Listing Description
  if (listing.description) {
    lines.push('## Listing Description');
    lines.push(listing.description);
    lines.push('');
  }

  // AI Analysis Summary
  if (listing.aiAnalysis) {
    try {
      const analysis = JSON.parse(listing.aiAnalysis);

      lines.push('## AI Analysis Summary');

      if (analysis.summary) {
        lines.push(analysis.summary);
        lines.push('');
      }

      // Red Flags
      const redFlags = listing.redFlags || analysis.concerns || [];
      if (redFlags.length > 0) {
        lines.push('### Red Flags');
        for (const flag of redFlags) {
          lines.push(`- ${flag}`);
        }
        lines.push('');
      }

      // Positives
      if (analysis.positives?.length > 0) {
        lines.push('### Positives');
        for (const p of analysis.positives) {
          lines.push(`- ${p}`);
        }
        lines.push('');
      }

      // Pricing info
      if (analysis.pricing) {
        lines.push('### Pricing Details');
        lines.push(`- **Type:** ${analysis.pricing.pricingType || 'Unknown'}`);
        lines.push(`- **Certification:** ${analysis.pricing.certificationStatus || 'Unknown'}`);
        if (analysis.pricing.mentionedFees?.length > 0) {
          lines.push('- **Mentioned Fees:**');
          for (const fee of analysis.pricing.mentionedFees) {
            const amt = fee.amount ? `$${fee.amount}` : 'amount unknown';
            lines.push(`  - ${fee.name}: ${amt}`);
          }
        }
        lines.push('');
      }

      // Deception flags
      if (analysis.deception) {
        const hasDeception =
          (analysis.deception.deceptiveLanguage?.length || 0) > 0 ||
          (analysis.deception.hiddenCosts?.length || 0) > 0 ||
          (analysis.deception.missingInfo?.length || 0) > 0;

        if (hasDeception) {
          lines.push('### Deception Flags');
          for (const d of analysis.deception.deceptiveLanguage || []) {
            lines.push(`- Suspicious: ${d}`);
          }
          for (const h of analysis.deception.hiddenCosts || []) {
            lines.push(`- Hidden cost: ${h}`);
          }
          for (const m of analysis.deception.missingInfo || []) {
            lines.push(`- Missing: ${m}`);
          }
          lines.push('');
        }
      }
    } catch {
      // If analysis isn't valid JSON, just include raw
      lines.push('## AI Analysis');
      lines.push(listing.aiAnalysis);
      lines.push('');
    }
  }

  // Notes
  if (listing.notes) {
    lines.push('## Notes');
    lines.push(listing.notes);
    lines.push('');
  }

  // Links
  lines.push('## Links');
  lines.push(`- [${listing.source.charAt(0).toUpperCase() + listing.source.slice(1)} Listing](${listing.sourceUrl})`);
  lines.push('');

  // Metadata
  lines.push('---');
  lines.push(`*Discovered: ${listing.discoveredAt}*`);
  lines.push(`*Info Readiness: ${calculateInfoReadiness(listing)}%*`);

  return lines.join('\n');
}

/**
 * Generate conversation.md content
 */
function generateConversationMarkdown(listing: Listing, db: ReturnType<typeof getDatabase>): string {
  const lines: string[] = [];

  lines.push('# Conversation with Seller\n');

  // Contact Info
  lines.push('## Contact Info');
  if (listing.sellerPhone) {
    lines.push(`- **Phone:** ${listing.sellerPhone}`);
  }
  if (listing.sellerEmail) {
    lines.push(`- **Email:** ${listing.sellerEmail}`);
  }
  if (!listing.sellerPhone && !listing.sellerEmail) {
    lines.push('*No contact information available*');
  }
  lines.push('');

  // Messages
  lines.push('## Messages\n');

  // Check for conversation in sellerConversation field
  if (listing.sellerConversation && listing.sellerConversation.length > 0) {
    for (const msg of listing.sellerConversation) {
      const date = new Date(msg.date).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
      const direction = msg.direction === 'outbound' ? 'Outbound' : 'Inbound';
      const channel = msg.channel ? ` (${msg.channel.toUpperCase()})` : '';

      lines.push(`### ${date} - ${direction}${channel}`);
      if (msg.subject) {
        lines.push(`**Subject:** ${msg.subject}\n`);
      }
      lines.push(msg.body);

      if (msg.attachments && msg.attachments.length > 0) {
        lines.push('\n**Attachments:**');
        for (const att of msg.attachments) {
          lines.push(`- [${path.basename(att)}](attachments/${path.basename(att)})`);
        }
      }
      lines.push('');
    }
  }

  // Also check emails table
  const emails = db.getEmailsForListing(listing.id);
  if (emails.length > 0) {
    for (const email of emails) {
      const date = new Date(email.createdAt).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
      const direction = email.direction === 'outbound' ? 'Outbound' : 'Inbound';

      lines.push(`### ${date} - ${direction} (Email)`);
      if (email.subject) {
        lines.push(`**Subject:** ${email.subject}\n`);
      }
      lines.push(email.body || '*No body*');

      if (email.attachments) {
        try {
          const atts = JSON.parse(email.attachments);
          if (atts.length > 0) {
            lines.push('\n**Attachments:**');
            for (const att of atts) {
              lines.push(`- [${att.filename}](attachments/${att.filename})`);
            }
          }
        } catch {}
      }
      lines.push('');
    }
  }

  if ((!listing.sellerConversation || listing.sellerConversation.length === 0) && emails.length === 0) {
    lines.push('*No messages yet*\n');
  }

  return lines.join('\n');
}

/**
 * Generate batch README.md
 */
function generateBatchReadme(listings: Listing[]): string {
  const lines: string[] = [];

  const today = new Date().toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  lines.push(`# Car Search Batch - ${today}\n`);

  // Summary stats
  const withCarfax = listings.filter(l => l.carfaxReceived).length;
  const withResponse = listings.filter(l =>
    l.sellerConversation?.some(m => m.direction === 'inbound')
  ).length;
  const prices = listings.map(l => l.price).filter((p): p is number => p !== null);
  const minPrice = prices.length > 0 ? Math.min(...prices) : 0;
  const maxPrice = prices.length > 0 ? Math.max(...prices) : 0;

  lines.push('## Summary');
  lines.push(`- **Total candidates:** ${listings.length}`);
  lines.push(`- **With CARFAX:** ${withCarfax} (${Math.round(withCarfax / listings.length * 100)}%)`);
  lines.push(`- **With seller response:** ${withResponse} (${Math.round(withResponse / listings.length * 100)}%)`);
  if (prices.length > 0) {
    lines.push(`- **Price range:** $${minPrice.toLocaleString()} - $${maxPrice.toLocaleString()}`);
  }
  lines.push('');

  // Candidates table
  lines.push('## Candidates\n');
  lines.push('| # | Vehicle | Price | Mileage | CARFAX | Seller Response | Score |');
  lines.push('|---|---------|-------|---------|--------|-----------------|-------|');

  listings.forEach((listing, idx) => {
    const num = idx + 1;
    const vehicle = `${listing.year} ${listing.make} ${listing.model}`;
    const price = listing.price ? `$${listing.price.toLocaleString()}` : 'N/A';
    const mileage = listing.mileageKm ? `${Math.round(listing.mileageKm / 1000)}k` : 'N/A';
    const carfax = listing.carfaxReceived ? 'Yes' : 'No';
    const response = listing.sellerConversation?.some(m => m.direction === 'inbound') ? 'Yes' : 'No';
    const score = listing.score !== null ? `${listing.score}` : '-';

    lines.push(`| ${num} | ${vehicle} | ${price} | ${mileage} | ${carfax} | ${response} | ${score} |`);
  });
  lines.push('');

  // Instructions
  lines.push('## Instructions\n');
  lines.push('Open this folder in Claude Code and ask:\n');
  lines.push('> Review all candidates and narrow to top 3. For each, recommend action: haggle, request more info, schedule viewing, or make offer.\n');
  lines.push('');
  lines.push('Or for more detailed analysis:\n');
  lines.push('> Analyze all candidates considering: (1) value for money, (2) accident history, (3) seller reliability, (4) negotiation potential. Provide a ranked recommendation with next steps for each.\n');

  return lines.join('\n');
}

/**
 * Get the next folder index in the batch directory
 */
function getNextFolderIndex(batchDir: string): number {
  if (!fs.existsSync(batchDir)) {
    return 1;
  }

  const entries = fs.readdirSync(batchDir, { withFileTypes: true });
  const folders = entries
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .filter(name => /^\d{3}-/.test(name))
    .map(name => parseInt(name.slice(0, 3), 10))
    .filter(n => !isNaN(n));

  return folders.length > 0 ? Math.max(...folders) + 1 : 1;
}

/**
 * Archive current batch and start fresh
 */
function archiveCurrentBatch(): void {
  const currentBatchPath = path.join(EXPORT_DIR, CURRENT_BATCH);
  if (!fs.existsSync(currentBatchPath)) {
    console.log('No current batch to archive.');
    return;
  }

  const timestamp = new Date().toISOString().split('T')[0];
  let archiveName = `batch-${timestamp}`;
  let counter = 1;

  while (fs.existsSync(path.join(EXPORT_DIR, archiveName))) {
    archiveName = `batch-${timestamp}-${counter}`;
    counter++;
  }

  const archivePath = path.join(EXPORT_DIR, archiveName);
  fs.renameSync(currentBatchPath, archivePath);
  console.log(`Archived current batch to: ${archivePath}`);
}

export const exportCommand = new Command('export')
  .description('Export interesting listings to disk for Claude analysis')
  .option('-s, --status <status>', 'Filter by status (comma-separated)', 'interesting')
  .option('--min-info <percent>', 'Minimum info readiness percentage', '0')
  .option('--force <ids>', 'Force re-export specific IDs (comma-separated)')
  .option('--new-batch', 'Archive current batch and start fresh')
  .action(async (options: ExportOptions) => {
    const db = getDatabase();

    // Handle --new-batch flag
    if (options.newBatch) {
      archiveCurrentBatch();
    }

    // Determine which listings to export
    let listings: Listing[];

    if (options.force) {
      // Force re-export specific IDs
      const ids = options.force.split(',').map(id => parseInt(id.trim(), 10));
      listings = db.getListingsByIds(ids);
      console.log(`Force re-exporting ${listings.length} listings...`);
    } else {
      // Get unexported listings with specified status
      const statuses = options.status.split(',').map(s => s.trim());
      listings = db.getUnexportedListings(statuses as any);

      // Filter by min info readiness
      const minInfo = parseInt(options.minInfo, 10);
      if (minInfo > 0) {
        listings = listings.filter(l => calculateInfoReadiness(l) >= minInfo);
      }

      if (listings.length === 0) {
        console.log(`\nNo unexported listings found with status: ${options.status}`);
        console.log('Run `carsearch triage` to mark listings as interesting.');
        console.log('Or use --force <ids> to re-export specific listings.\n');
        return;
      }

      console.log(`Found ${listings.length} listings to export...`);
    }

    // Create export directory structure
    const batchDir = path.join(EXPORT_DIR, CURRENT_BATCH);
    fs.mkdirSync(batchDir, { recursive: true });

    // Get starting index for new folders
    let folderIndex = getNextFolderIndex(batchDir);

    // Export each listing
    const exportedIds: number[] = [];

    for (const listing of listings) {
      const folderName = generateFolderName(folderIndex, listing);
      const listingDir = path.join(batchDir, folderName);

      // Create listing directory
      fs.mkdirSync(listingDir, { recursive: true });

      // Write listing.md
      const listingMd = generateListingMarkdown(listing);
      fs.writeFileSync(path.join(listingDir, 'listing.md'), listingMd);

      // Write conversation.md
      const conversationMd = generateConversationMarkdown(listing, db);
      fs.writeFileSync(path.join(listingDir, 'conversation.md'), conversationMd);

      // Copy CARFAX if available
      if (listing.carfaxPath && fs.existsSync(listing.carfaxPath)) {
        const carfaxDest = path.join(listingDir, 'carfax.pdf');
        fs.copyFileSync(listing.carfaxPath, carfaxDest);
      }

      // Copy attachments if any
      const attachments = db.getAttachments(listing.id);
      if (attachments.length > 0) {
        const attachmentsDir = path.join(listingDir, 'attachments');
        fs.mkdirSync(attachmentsDir, { recursive: true });

        for (const att of attachments) {
          if (att.isRelevant && fs.existsSync(att.filePath)) {
            const dest = path.join(attachmentsDir, att.filename);
            fs.copyFileSync(att.filePath, dest);
          }
        }
      }

      console.log(`  Exported: ${folderName}`);
      exportedIds.push(listing.id);
      folderIndex++;
    }

    // Mark listings as exported (unless --force was used)
    if (!options.force) {
      db.markExported(exportedIds);
    }

    // Get all listings in the batch for README
    const allListings = options.force
      ? listings
      : db.listListings({ status: options.status.split(',') as any });

    // Regenerate README with all listings
    const allExportedListings = allListings.filter(l => l.exportedAt !== null || exportedIds.includes(l.id));
    const readme = generateBatchReadme(allExportedListings.length > 0 ? allExportedListings : listings);
    fs.writeFileSync(path.join(batchDir, 'README.md'), readme);

    console.log(`\nExport complete!`);
    console.log(`  Location: ${batchDir}`);
    console.log(`  Listings: ${exportedIds.length}`);
    console.log(`\nNext step: Open ${batchDir} in Claude and ask for analysis.\n`);
  });
