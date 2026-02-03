/**
 * Process Links Command
 * Extract and analyze links from dealer emails or manually provided URLs
 */

import { Command } from 'commander';
import { getDatabase } from '../../database/index.js';
import {
  extractLinksFromEmail,
  filterRelevantLinks,
  fetchAndAnalyzeLink,
  processEmailLinks,
  type ExtractedLink,
} from '../../email/link-processor.js';
import { EmailClient } from '../../email/client.js';
import { writeSearchContext, WORKSPACE_DIR } from '../../workspace/index.js';

export const processLinksCommand = new Command('process-links')
  .description('Extract and analyze links from dealer emails')
  .option('-l, --listing <id>', 'Listing ID to search emails for')
  .option('-u, --url <url>', 'Directly analyze a specific URL')
  .option('--dry-run', 'Show links without fetching them')
  .action(async (options) => {
    const db = getDatabase();

    // Mode 1: Analyze a specific URL
    if (options.url) {
      console.log(`\n🔗 Analyzing URL: ${options.url}\n`);

      if (options.dryRun) {
        console.log('[DRY RUN] Would fetch and analyze URL');
        return;
      }

      writeSearchContext();
      const result = await fetchAndAnalyzeLink(options.url, WORKSPACE_DIR);
      if (result) {
        console.log('📄 Analysis Results:\n');
        console.log(`  Title:       ${result.title}`);
        console.log(`  Description: ${result.description || 'N/A'}`);
        console.log(`  VIN:         ${result.vin || 'Not found'}`);
        console.log(`  Price:       ${result.price ? `$${result.price.toLocaleString()}` : 'Not found'}`);
        console.log(`  Mileage:     ${result.mileage ? `${result.mileage.toLocaleString()} km` : 'Not found'}`);

        if (Object.keys(result.specs).length > 0) {
          console.log('\n  Specs:');
          for (const [key, value] of Object.entries(result.specs)) {
            console.log(`    ${key}: ${value}`);
          }
        }

        if (result.photoUrls.length > 0) {
          console.log(`\n  Photos: ${result.photoUrls.length} found`);
          for (const url of result.photoUrls.slice(0, 5)) {
            console.log(`    - ${url.slice(0, 80)}...`);
          }
        }

        if (result.carfaxUrl) {
          console.log(`\n  CARFAX URL: ${result.carfaxUrl}`);
        }

        if (result.rawText) {
          console.log(`\n  Raw text snippet:\n    ${result.rawText.slice(0, 300)}...`);
        }
      } else {
        console.log('❌ Failed to analyze URL');
      }
      return;
    }

    // Mode 2: Process emails for a specific listing
    if (options.listing) {
      const listingId = parseInt(options.listing, 10);
      const listing = db.getListing(listingId);

      if (!listing) {
        console.error(`❌ Listing #${listingId} not found`);
        process.exit(1);
      }

      console.log(`\n🔍 Searching emails for listing #${listingId}`);
      console.log(`   ${listing.year} ${listing.make} ${listing.model}`);
      console.log(`   Seller: ${listing.sellerName || 'Unknown'}\n`);

      try {
        const emailClient = new EmailClient();

        // Search for emails mentioning the vehicle or from the seller
        const searchQuery: { from?: string; subject?: string } = {};
        if (listing.sellerEmail) {
          searchQuery.from = listing.sellerEmail;
        } else {
          searchQuery.subject = `${listing.make} ${listing.model}`;
        }

        const emails = await emailClient.searchEmails(searchQuery);
        emailClient.close();

        if (emails.length === 0) {
          console.log('No matching emails found');
          return;
        }

        console.log(`Found ${emails.length} email(s)\n`);

        let totalLinks = 0;
        let totalProcessed = 0;

        for (const email of emails) {
          console.log(`📧 ${email.subject}`);
          console.log(`   From: ${email.from}`);
          console.log(`   Date: ${email.date.toLocaleDateString()}`);

          const links = extractLinksFromEmail(email);
          const relevant = filterRelevantLinks(links);
          totalLinks += relevant.length;

          console.log(`   Links: ${links.length} total, ${relevant.length} relevant\n`);

          if (relevant.length > 0) {
            // Group by type
            const byType: Record<string, ExtractedLink[]> = {};
            for (const link of relevant) {
              if (!byType[link.type]) byType[link.type] = [];
              byType[link.type].push(link);
            }

            for (const [type, typeLinks] of Object.entries(byType)) {
              console.log(`   ${type.toUpperCase()} links:`);
              for (const link of typeLinks) {
                console.log(`     - ${link.url.slice(0, 70)}${link.url.length > 70 ? '...' : ''}`);
                if (link.text) {
                  console.log(`       Text: "${link.text}"`);
                }
              }
            }

            if (!options.dryRun) {
              console.log('\n   Processing links...');
              const results = await processEmailLinks(email, listing);
              totalProcessed += results.linksProcessed;

              if (results.enrichedData && Object.keys(results.enrichedData).length > 0) {
                console.log('   ✅ Enriched data found:');
                for (const [key, value] of Object.entries(results.enrichedData)) {
                  console.log(`      ${key}: ${value}`);
                }
              }

              if (results.carfaxUrl) {
                console.log(`   📄 CARFAX URL: ${results.carfaxUrl}`);
              }

              if (results.additionalPhotos.length > 0) {
                console.log(`   📷 Found ${results.additionalPhotos.length} photos`);
              }
            }
          }
          console.log('');
        }

        console.log('─'.repeat(50));
        console.log(`Summary: ${totalLinks} links found, ${totalProcessed} processed`);
      } catch (error) {
        console.error(`❌ Error: ${error}`);
      }
      return;
    }

    // No options specified - show help
    console.log('\nUsage:');
    console.log('  process-links --url <url>        Analyze a specific URL');
    console.log('  process-links --listing <id>     Process emails for a listing');
    console.log('  process-links --listing <id> --dry-run   Show links without fetching\n');
  });
