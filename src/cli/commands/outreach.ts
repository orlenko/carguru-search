import { Command } from 'commander';
import { loadConfig, getEnv } from '../../config.js';
import { getDatabase } from '../../database/index.js';
import { rankListings } from '../../ranking/scorer.js';
import { calculateTotalCost } from '../../pricing/calculator.js';
import { WebFormContact, generateContactMessage } from '../../contact/web-form.js';
import { EmailClient } from '../../email/client.js';
import { generateEmail } from '../../email/templates.js';
import { shouldSkipEmail } from '../../email/filters.js';
import { analyzeCarfaxBuffer } from '../../analyzers/carfax-analyzer.js';
import type { ListingAnalysis } from '../../analyzers/listing-analyzer.js';
import type { Listing } from '../../database/client.js';
import { matchListingFromEmail } from '../../email/matching.js';
import * as fs from 'fs';
import * as path from 'path';

export const outreachCommand = new Command('outreach')
  .description('Automatically contact top-ranked listings')
  .option('-n, --limit <number>', 'Max listings to contact', '10')
  .option('--min-score <score>', 'Minimum score to contact', '50')
  .option('--dry-run', 'Show what would be contacted without actually contacting')
  .option('--headless', 'Run browser in headless mode')
  .action(async (options) => {
    try {
      const config = loadConfig();
      const db = getDatabase();
      const dryRun = options.dryRun ?? false;
      const minScore = parseInt(options.minScore, 10);
      const limit = parseInt(options.limit, 10);
      const budget = config.search.priceMax || 18000;

      console.log('\n📧 Automated Outreach\n');

      // Get all listings and rank them
      const listings = db.listListings({ limit: 1000 });
      const analyses = new Map<number, ListingAnalysis>();

      for (const listing of listings) {
        if (listing.aiAnalysis) {
          try {
            analyses.set(listing.id, JSON.parse(listing.aiAnalysis));
          } catch {}
        }
      }

      const ranked = rankListings(listings, analyses, config.scoring);

      // Filter: within budget, good score, not already contacted
      const candidates = ranked.filter(({ listing, score }) => {
        // Must pass scoring
        if (!score.passed || score.totalScore < minScore) return false;
        if (listing.status !== 'analyzed') return false;

        // Must not have been contacted already
        if (listing.status === 'contacted' || listing.contactAttempts > 0) return false;

        // Check if within budget (estimated total cost)
        if (listing.price) {
          const isDealer = listing.sellerType === 'dealer';
          const analysis = analyses.get(listing.id);
          const cost = calculateTotalCost(listing.price, analysis?.pricing || null, budget, isDealer);
          if (!cost.withinBudget) return false;
        }

        return true;
      }).slice(0, limit);

      if (candidates.length === 0) {
        console.log('No new candidates to contact.');
        console.log('\nPossible reasons:');
        console.log('  - All good candidates already contacted');
        console.log('  - No listings meet the minimum score requirement');
        console.log('  - All listings exceed budget after fees/taxes');
        console.log('\nRun `carsearch rank --all` to see all listings.');
        return;
      }

      console.log(`Found ${candidates.length} candidates to contact:\n`);

      const buyerName = getEnv('BUYER_NAME', false) || 'Interested Buyer';
      const buyerEmail = getEnv('EMAIL_USER');
      const buyerPhone = getEnv('BUYER_PHONE', false);

      const webContact = new WebFormContact();
      let contacted = 0;
      let failed = 0;

      for (const { listing, score } of candidates) {
        const vehicle = `${listing.year} ${listing.make} ${listing.model}`;
        console.log(`─────────────────────────────────────────`);
        console.log(`#${listing.id}: ${vehicle}`);
        console.log(`Score: ${score.totalScore} | Price: $${listing.price?.toLocaleString()}`);
        console.log(`Seller: ${listing.sellerName || 'Unknown'}`);
        console.log(`URL: ${listing.sourceUrl}`);

        if (dryRun) {
          console.log(`[DRY RUN - Would contact]`);
          contacted++;
          continue;
        }

        try {
          // Generate message
          const message = generateContactMessage(listing, 'inquiry');

          // Try web form first
          console.log('\nAttempting web form contact...');
          const result = await webContact.contactViaAutoTrader(
            listing,
            {
              name: buyerName,
              email: buyerEmail,
              phone: buyerPhone,
              message,
            },
            { headless: options.headless, dryRun: false }
          );

          if (result.success) {
            console.log(`✅ ${result.message}`);

            // Update listing status
            db.updateListing(listing.id, {
              lastContactedAt: new Date().toISOString(),
              contactAttempts: (listing.contactAttempts || 0) + 1,
              sellerEmail: result.dealerEmail,
              sellerPhone: result.dealerPhone,
              infoStatus: 'carfax_requested',
            });
            const transitionResult = db.transitionStatePath(listing.id, 'awaiting_response', {
              triggeredBy: 'system',
              reasoning: 'Initial outreach sent',
            });
            if (!transitionResult.success) {
              console.log(`⚠️ State transition failed: ${transitionResult.error}`);
            }

            contacted++;
          } else {
            console.log(`❌ Web form failed: ${result.message}`);

            // If we extracted contact info, save it
            if (result.dealerEmail || result.dealerPhone) {
              db.updateListing(listing.id, {
                sellerEmail: result.dealerEmail,
                sellerPhone: result.dealerPhone,
              });
              console.log(`   Extracted: Email=${result.dealerEmail || 'N/A'}, Phone=${result.dealerPhone || 'N/A'}`);
            }

            failed++;
          }
        } catch (error) {
          console.log(`❌ Error: ${error}`);
          failed++;
        }

        // Delay between contacts
        if (candidates.indexOf({ listing, score } as any) < candidates.length - 1) {
          console.log('\nWaiting before next contact...');
          await new Promise(r => setTimeout(r, 5000));
        }
      }

      console.log(`\n${'═'.repeat(40)}`);
      console.log(`Outreach complete:`);
      console.log(`  Contacted: ${contacted}`);
      console.log(`  Failed: ${failed}`);

      if (dryRun) {
        console.log(`\n[DRY RUN - No actual contacts made]`);
        console.log(`Run without --dry-run to actually contact sellers.`);
      } else {
        console.log(`\nNext steps:`);
        console.log(`  1. Run \`carsearch check-email\` to monitor responses`);
        console.log(`  2. Run \`carsearch inbox\` to see conversation status`);
      }
    } catch (error) {
      console.error('Outreach failed:', error);
      process.exit(1);
    }
  });

export const inboxCommand = new Command('inbox')
  .description('Show inbox status and pending conversations')
  .option('--check', 'Also check for new emails/SMS')
  .action(async (options) => {
    try {
      const db = getDatabase();

      console.log('\n📬 Inbox Status\n');

      // Get contacted listings
      const contacted = db.listListings({
        status: ['contacted', 'awaiting_response', 'negotiating'] as any,
        limit: 100,
      });

      if (contacted.length === 0) {
        console.log('No active conversations.');
        console.log('Run `carsearch outreach` to start contacting sellers.');
        return;
      }

      // Check for new emails if requested
      if (options.check) {
        console.log('Checking for new messages...\n');
        try {
          const emailClient = new EmailClient();
          const emails = await emailClient.fetchNewEmails();
          if (emails.length > 0) {
            console.log(`📧 ${emails.length} new email(s) received!\n`);
          }
          emailClient.close();
        } catch (error) {
          console.log('Could not check email:', error);
        }
      }

      console.log('Active Conversations:\n');
      console.log('─'.repeat(80));

      for (const listing of contacted) {
        const vehicle = `${listing.year} ${listing.make} ${listing.model}`;
        const lastContact = listing.lastContactedAt
          ? new Date(listing.lastContactedAt).toLocaleDateString()
          : 'Unknown';

        console.log(`#${listing.id}: ${vehicle}`);
        console.log(`   Seller: ${listing.sellerName || 'Unknown'}`);
        console.log(`   Price: $${listing.price?.toLocaleString()} | Contacted: ${lastContact}`);
        console.log(`   Attempts: ${listing.contactAttempts}`);

        // Show CARFAX status
        if (listing.carfaxReceived) {
          console.log(`   📄 CARFAX: Received ✅`);
        } else {
          console.log(`   📄 CARFAX: Pending`);
        }

        console.log('');
      }

      console.log('─'.repeat(80));
      console.log(`\nTotal: ${contacted.length} active conversation(s)`);
      console.log(`\nCommands:`);
      console.log(`  carsearch check-email     - Check for dealer responses`);
      console.log(`  carsearch show <id>       - View listing details`);
      console.log(`  carsearch respond <id>    - Generate response to dealer`);
    } catch (error) {
      console.error('Failed to show inbox:', error);
      process.exit(1);
    }
  });

export const autoRespondCommand = new Command('auto-respond')
  .description('Automatically respond to dealer emails with CARFAX requests')
  .option('--dry-run', 'Show what would be sent without sending')
  .action(async (options) => {
    try {
      const db = getDatabase();
      const emailClient = new EmailClient();

      console.log('\n🤖 Auto-Respond: Checking for emails needing response...\n');

      // Get new emails
      const emails = await emailClient.fetchNewEmails();
      const processedEmailIds = db.getProcessedEmailIds();

      if (emails.length === 0) {
        console.log('No new emails to process.');
        emailClient.close();
        return;
      }

      console.log(`Found ${emails.length} new email(s)\n`);

      // Get contacted listings for matching
      const contactedListings = db.listListings({
        status: ['contacted', 'awaiting_response', 'negotiating'] as any,
        limit: 100,
      });

      for (const email of emails) {
        console.log('─'.repeat(60));
        console.log(`From: ${email.from}`);
        console.log(`Subject: ${email.subject}`);

        if (email.messageId && processedEmailIds.has(email.messageId)) {
          console.log('⏭️  Already processed - skipping');
          continue;
        }

        // Check if we should skip this email (noreply, automated, marketing)
        const skipCheck = shouldSkipEmail(email);
        if (skipCheck.skip) {
          console.log(`⏭️  Skipping: ${skipCheck.reason}`);
          if (!options.dryRun && email.messageId) {
            db.markEmailProcessed({
              messageId: email.messageId,
              fromAddress: email.from,
              subject: email.subject,
              action: `skipped: ${skipCheck.reason}`,
            });
            processedEmailIds.add(email.messageId);
          }
          continue;
        }

        console.log(`Preview: ${email.text.slice(0, 100)}...`);

        // Try to match email to a listing
        const matchedListing = matchListingFromEmail(email, contactedListings);

        if (matchedListing) {
          console.log(`\n✅ Matched to: #${matchedListing.id} ${matchedListing.year} ${matchedListing.make} ${matchedListing.model}`);

          // Check if CARFAX attached
          const hasCarfax = email.attachments.some(
            a => a.contentType === 'application/pdf' &&
                 (a.filename.toLowerCase().includes('carfax') ||
                  a.filename.toLowerCase().includes('history'))
          );

          if (hasCarfax) {
            console.log('📄 CARFAX detected in attachments!');

            // Find the CARFAX attachment
            const carfaxAttachment = email.attachments.find(
              a => a.contentType === 'application/pdf' &&
                   (a.filename.toLowerCase().includes('carfax') ||
                    a.filename.toLowerCase().includes('history'))
            );

            if (carfaxAttachment) {
              // Save CARFAX to disk
              const carfaxDir = path.join('data', 'carfax');
              fs.mkdirSync(carfaxDir, { recursive: true });
              const carfaxPath = path.join(carfaxDir, `listing-${matchedListing.id}.pdf`);
              fs.writeFileSync(carfaxPath, carfaxAttachment.content);
              console.log(`   Saved to: ${carfaxPath}`);

              // Analyze CARFAX
              try {
                console.log('   Analyzing CARFAX...');
                const analysis = await analyzeCarfaxBuffer(carfaxAttachment.content);

                const riskEmoji: Record<string, string> = {
                  'severe': '🔴',
                  'high': '🟠',
                  'medium': '🟡',
                  'low': '🟢',
                };
                console.log(`   ${riskEmoji[analysis.riskLevel]} Risk: ${analysis.riskLevel.toUpperCase()}`);
                console.log(`   Accidents: ${analysis.data.accidentCount} | Owners: ${analysis.data.ownerCount || 'N/A'}`);

                // Update listing with CARFAX data
                db.updateListing(matchedListing.id, {
                  carfaxReceived: true,
                  carfaxPath,
                  infoStatus: 'carfax_received',
                  accidentCount: analysis.data.accidentCount,
                  ownerCount: analysis.data.ownerCount,
                  serviceRecordCount: analysis.data.serviceRecordCount,
                  carfaxSummary: analysis.summary,
                });

                // Add risk factors to notes
                if (analysis.riskFactors.length > 0) {
                  const existingNotes = matchedListing.notes || '';
                  const carfaxNotes = `\n[CARFAX ${new Date().toISOString().split('T')[0]}]\nRisk: ${analysis.riskLevel}\n${analysis.riskFactors.map(f => `- ${f}`).join('\n')}`;
                  db.updateListing(matchedListing.id, {
                    notes: existingNotes + carfaxNotes,
                  });
                }

                console.log('   ✅ CARFAX analyzed and saved');
              } catch (analyzeError) {
                console.log(`   ⚠️ Analysis failed: ${analyzeError}`);
                // Still mark as received even if analysis failed
                db.updateListing(matchedListing.id, {
                  carfaxReceived: true,
                  carfaxPath,
                  infoStatus: 'carfax_received',
                });
              }
            }
          } else if (!matchedListing.carfaxReceived) {
            // No CARFAX yet - send request
            console.log('📄 No CARFAX yet - generating request...');

            const { subject, text } = generateEmail('carfax_request', { listing: matchedListing });

            if (options.dryRun) {
              console.log(`\n[DRY RUN] Would send:`);
              console.log(`To: ${email.from}`);
              console.log(`Subject: ${subject}`);
              console.log(`Body: ${text.slice(0, 200)}...`);
            } else {
              // Extract email address from "Name <email>" format
              const emailMatch = email.from.match(/<(.+)>/) || [null, email.from];
              const replyTo = emailMatch[1];

              await emailClient.send({
                to: replyTo,
                subject: `Re: ${email.subject}`,
                text,
              });
              db.updateListing(matchedListing.id, { infoStatus: 'carfax_requested' });
              console.log(`✅ CARFAX request sent to ${replyTo}`);
            }
          }

          if (!options.dryRun) {
            const transitionResult = db.transitionStatePath(matchedListing.id, 'negotiating', {
              triggeredBy: 'system',
              reasoning: 'Received seller response',
            });
            if (!transitionResult.success) {
              console.log(`⚠️ State transition failed: ${transitionResult.error}`);
            }
          }

          if (!options.dryRun && email.messageId) {
            db.markEmailProcessed({
              messageId: email.messageId,
              listingId: matchedListing.id,
              fromAddress: email.from,
              subject: email.subject,
              action: 'auto_respond_processed',
            });
            processedEmailIds.add(email.messageId);
          }
        } else {
          console.log('\n❓ Could not match to any listing');
          if (!options.dryRun && email.messageId) {
            db.markEmailProcessed({
              messageId: email.messageId,
              fromAddress: email.from,
              subject: email.subject,
              action: 'unmatched',
            });
            processedEmailIds.add(email.messageId);
          }
        }
      }

      emailClient.close();

      console.log('\n' + '─'.repeat(60));
      if (options.dryRun) {
        console.log('[DRY RUN - No emails sent]');
      }
      console.log('Done.');
    } catch (error) {
      console.error('Auto-respond failed:', error);
      process.exit(1);
    }
  });
