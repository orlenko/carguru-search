/**
 * Automated pipeline command that orchestrates the full car search workflow:
 * search → analyze → outreach → auto-respond (with CARFAX analysis)
 */

import { Command } from 'commander';
import { loadConfig, getEnv } from '../../config.js';
import { getDatabase } from '../../database/index.js';
import { rankListings } from '../../ranking/scorer.js';
import { calculateTotalCost } from '../../pricing/calculator.js';
import { WebFormContact, generateContactMessage } from '../../contact/web-form.js';
import { EmailClient } from '../../email/client.js';
import { generateEmail } from '../../email/templates.js';
import { analyzeCarfaxBuffer } from '../../analyzers/carfax-analyzer.js';
import { analyzeListingWithClaude } from '../../analyzers/listing-analyzer.js';
import { AutoTraderScraper } from '../../scrapers/autotrader.js';
import type { ListingAnalysis } from '../../analyzers/listing-analyzer.js';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Check if an email should be skipped (automated, noreply, marketing, etc.)
 */
function shouldSkipEmail(email: { from: string; subject: string; text: string }): { skip: boolean; reason: string } {
  const fromLower = email.from.toLowerCase();
  const subjectLower = email.subject.toLowerCase();

  // Skip noreply addresses
  if (fromLower.includes('noreply') || fromLower.includes('no-reply') || fromLower.includes('donotreply')) {
    return { skip: true, reason: 'noreply address' };
  }

  // Skip automated/system addresses
  const automatedPatterns = [
    'mailer-daemon', 'postmaster', 'autoresponder', 'auto-reply', 'automated',
    'notification@', 'notifications@', 'alert@', 'alerts@', 'system@',
  ];
  for (const pattern of automatedPatterns) {
    if (fromLower.includes(pattern)) {
      return { skip: true, reason: `automated address` };
    }
  }

  // Skip marketing/newsletter subjects
  const marketingSubjects = [
    'subscription confirmed', 'you\'re subscribed', 'welcome to', 'thank you for signing up',
    'price alert', 'price drop', 'similar vehicles', 'new listings', 'unsubscribe',
    'weekly digest', 'daily digest', 'newsletter',
  ];
  for (const pattern of marketingSubjects) {
    if (subjectLower.includes(pattern)) {
      return { skip: true, reason: `marketing email` };
    }
  }

  if (subjectLower.includes('confirmation') && !subjectLower.includes('viewing')) {
    return { skip: true, reason: 'confirmation email' };
  }

  return { skip: false, reason: '' };
}

interface PipelineOptions {
  dryRun: boolean;
  searchLimit: number;
  contactLimit: number;
  minScore: number;
  skipSearch: boolean;
  skipAnalyze: boolean;
  skipOutreach: boolean;
  skipRespond: boolean;
  headless: boolean;
}

export const pipelineCommand = new Command('pipeline')
  .description('Run the full automated pipeline: search → analyze → outreach → respond')
  .option('--dry-run', 'Show what would be done without actually doing it')
  .option('--search-limit <n>', 'Max pages to search', '3')
  .option('--contact-limit <n>', 'Max listings to contact', '5')
  .option('--min-score <n>', 'Minimum score to contact', '50')
  .option('--skip-search', 'Skip the search phase')
  .option('--skip-analyze', 'Skip the analysis phase')
  .option('--skip-outreach', 'Skip the outreach phase')
  .option('--skip-respond', 'Skip the auto-respond phase')
  .option('--headless', 'Run browser in headless mode')
  .action(async (opts) => {
    const options: PipelineOptions = {
      dryRun: opts.dryRun ?? false,
      searchLimit: parseInt(opts.searchLimit, 10),
      contactLimit: parseInt(opts.contactLimit, 10),
      minScore: parseInt(opts.minScore, 10),
      skipSearch: opts.skipSearch ?? false,
      skipAnalyze: opts.skipAnalyze ?? false,
      skipOutreach: opts.skipOutreach ?? false,
      skipRespond: opts.skipRespond ?? false,
      headless: opts.headless ?? false,
    };

    console.log('\n🚀 CAR SEARCH AUTOMATION PIPELINE\n');
    console.log('='.repeat(60));

    if (options.dryRun) {
      console.log('🔍 DRY RUN MODE - No actions will be taken\n');
    }

    const config = loadConfig();
    const db = getDatabase();
    const results = {
      searched: 0,
      newListings: 0,
      analyzed: 0,
      contacted: 0,
      emailsProcessed: 0,
      carfaxReceived: 0,
    };

    // ═══════════════════════════════════════════════════════════════
    // PHASE 1: SEARCH
    // ═══════════════════════════════════════════════════════════════
    if (!options.skipSearch) {
      console.log('\n📡 PHASE 1: SEARCH\n');
      console.log('-'.repeat(40));

      try {
        const searchParams = {
          make: config.search.make,
          model: config.search.model,
          yearMin: config.search.yearMin,
          yearMax: config.search.yearMax,
          priceMax: config.search.priceMax,
          mileageMax: config.search.mileageMax,
          postalCode: config.search.postalCode,
          radius: config.search.radiusKm,
        };

        console.log(`Searching for: ${searchParams.make} ${searchParams.model}`);
        console.log(`Years: ${searchParams.yearMin}-${searchParams.yearMax}`);
        console.log(`Max price: $${searchParams.priceMax?.toLocaleString()}`);
        console.log(`Location: ${searchParams.postalCode}, ${searchParams.radius}km radius\n`);

        if (!options.dryRun) {
          const scraper = new AutoTraderScraper({
            headless: options.headless,
            slowMo: 50,
          });

          const searchResult = await scraper.search(config.search);
          results.searched = searchResult.listings.length;

          // Save to database
          for (const listing of searchResult.listings) {
            const existing = db.getListingBySourceId(listing.source, listing.sourceId);
            if (!existing) {
              db.upsertListing(listing);
              results.newListings++;
            } else if (existing.price !== listing.price && listing.price) {
              db.recordPriceChange(existing.id, listing.price);
              db.updateListing(existing.id, { price: listing.price });
            }
          }

          console.log(`✅ Found ${results.searched} listings (${results.newListings} new)`);
        } else {
          console.log('[DRY RUN] Would search AutoTrader');
        }
      } catch (error) {
        console.error(`❌ Search failed: ${error}`);
      }
    } else {
      console.log('\n⏭️  PHASE 1: SEARCH (skipped)\n');
    }

    // ═══════════════════════════════════════════════════════════════
    // PHASE 2: ANALYZE
    // ═══════════════════════════════════════════════════════════════
    if (!options.skipAnalyze) {
      console.log('\n🔬 PHASE 2: ANALYZE\n');
      console.log('-'.repeat(40));

      const unanalyzed = db.listListings({ status: 'new', limit: 100 })
        .filter(l => !l.aiAnalysis);

      console.log(`Found ${unanalyzed.length} listings needing analysis\n`);

      if (!options.dryRun && unanalyzed.length > 0) {
        for (const listing of unanalyzed) {
          const vehicle = `${listing.year} ${listing.make} ${listing.model}`;
          process.stdout.write(`  Analyzing #${listing.id}: ${vehicle}...`);

          try {
            const analysis = await analyzeListingWithClaude(listing);
            db.updateListing(listing.id, {
              aiAnalysis: JSON.stringify(analysis),
              score: analysis.recommendationScore,
              redFlags: analysis.concerns,
              status: 'analyzed',
            });
            results.analyzed++;
            console.log(` ✅ Score: ${analysis.recommendationScore}`);
          } catch (error) {
            console.log(` ❌ Failed`);
          }

          // Rate limiting
          await new Promise(r => setTimeout(r, 1000));
        }
        console.log(`\n✅ Analyzed ${results.analyzed} listings`);
      } else if (options.dryRun) {
        console.log(`[DRY RUN] Would analyze ${unanalyzed.length} listings`);
      }
    } else {
      console.log('\n⏭️  PHASE 2: ANALYZE (skipped)\n');
    }

    // ═══════════════════════════════════════════════════════════════
    // PHASE 3: OUTREACH
    // ═══════════════════════════════════════════════════════════════
    if (!options.skipOutreach) {
      console.log('\n📧 PHASE 3: OUTREACH\n');
      console.log('-'.repeat(40));

      const budget = config.search.priceMax || 18000;

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

      // Filter candidates
      const candidates = ranked.filter(({ listing, score }) => {
        if (!score.passed || score.totalScore < options.minScore) return false;
        if (listing.status === 'contacted' || listing.contactAttempts > 0) return false;
        if (listing.price) {
          const isDealer = listing.sellerType === 'dealer';
          const analysis = analyses.get(listing.id);
          const cost = calculateTotalCost(listing.price, analysis?.pricing || null, budget, isDealer);
          if (!cost.withinBudget) return false;
        }
        return true;
      }).slice(0, options.contactLimit);

      console.log(`Found ${candidates.length} candidates to contact\n`);

      if (!options.dryRun && candidates.length > 0) {
        const buyerName = getEnv('BUYER_NAME', false) || 'Interested Buyer';
        const buyerEmail = getEnv('EMAIL_USER');
        const buyerPhone = getEnv('BUYER_PHONE', false);
        const webContact = new WebFormContact();

        for (const { listing, score } of candidates) {
          const vehicle = `${listing.year} ${listing.make} ${listing.model}`;
          console.log(`  Contacting #${listing.id}: ${vehicle} (score: ${score.totalScore})`);

          try {
            const message = generateContactMessage(listing, 'inquiry');
            const result = await webContact.contactViaAutoTrader(
              listing,
              { name: buyerName, email: buyerEmail, phone: buyerPhone, message },
              { headless: options.headless, dryRun: false }
            );

            if (result.success) {
              db.updateListing(listing.id, {
                status: 'contacted',
                lastContactedAt: new Date().toISOString(),
                contactAttempts: (listing.contactAttempts || 0) + 1,
                sellerEmail: result.dealerEmail,
                sellerPhone: result.dealerPhone,
              });
              results.contacted++;
              console.log(`    ✅ Contacted`);
            } else {
              console.log(`    ❌ Failed: ${result.message}`);
            }
          } catch (error) {
            console.log(`    ❌ Error: ${error}`);
          }

          await new Promise(r => setTimeout(r, 5000));
        }
        console.log(`\n✅ Contacted ${results.contacted} sellers`);
      } else if (options.dryRun) {
        for (const { listing, score } of candidates) {
          console.log(`  [DRY RUN] Would contact #${listing.id}: ${listing.year} ${listing.make} ${listing.model}`);
        }
      }
    } else {
      console.log('\n⏭️  PHASE 3: OUTREACH (skipped)\n');
    }

    // ═══════════════════════════════════════════════════════════════
    // PHASE 4: AUTO-RESPOND
    // ═══════════════════════════════════════════════════════════════
    if (!options.skipRespond) {
      console.log('\n🤖 PHASE 4: AUTO-RESPOND\n');
      console.log('-'.repeat(40));

      try {
        const emailClient = new EmailClient();
        const emails = await emailClient.fetchNewEmails();

        console.log(`Found ${emails.length} new email(s)\n`);

        if (emails.length > 0) {
          const contactedListings = db.listListings({ status: 'contacted', limit: 100 });

          for (const email of emails) {
            console.log(`  From: ${email.from.slice(0, 50)}...`);

            // Skip noreply/automated/marketing emails
            const skipCheck = shouldSkipEmail(email);
            if (skipCheck.skip) {
              console.log(`    ⏭️  Skipping: ${skipCheck.reason}`);
              continue;
            }

            results.emailsProcessed++;

            // Match to listing
            const matchedListing = contactedListings.find(listing => {
              if (listing.sellerEmail && email.from.includes(listing.sellerEmail)) return true;
              if (listing.sellerName && email.from.toLowerCase().includes(listing.sellerName.toLowerCase())) return true;
              const vehicle = `${listing.make} ${listing.model}`.toLowerCase();
              if (email.subject.toLowerCase().includes(vehicle)) return true;
              return false;
            });

            if (matchedListing) {
              console.log(`    Matched to #${matchedListing.id}`);

              // Check for CARFAX
              const carfaxAttachment = email.attachments.find(
                a => a.contentType === 'application/pdf' &&
                     (a.filename.toLowerCase().includes('carfax') ||
                      a.filename.toLowerCase().includes('history'))
              );

              if (carfaxAttachment) {
                console.log('    📄 CARFAX detected!');

                if (!options.dryRun) {
                  // Save and analyze
                  const carfaxDir = path.join('data', 'carfax');
                  fs.mkdirSync(carfaxDir, { recursive: true });
                  const carfaxPath = path.join(carfaxDir, `listing-${matchedListing.id}.pdf`);
                  fs.writeFileSync(carfaxPath, carfaxAttachment.content);

                  try {
                    const analysis = await analyzeCarfaxBuffer(carfaxAttachment.content);
                    db.updateListing(matchedListing.id, {
                      carfaxReceived: true,
                      carfaxPath,
                      accidentCount: analysis.data.accidentCount,
                      ownerCount: analysis.data.ownerCount,
                      serviceRecordCount: analysis.data.serviceRecordCount,
                      carfaxSummary: analysis.summary,
                    });
                    results.carfaxReceived++;
                    console.log(`    ✅ CARFAX analyzed: ${analysis.riskLevel} risk`);
                  } catch (e) {
                    db.updateListing(matchedListing.id, { carfaxReceived: true, carfaxPath });
                    console.log(`    ⚠️ Saved but analysis failed`);
                  }
                } else {
                  console.log('    [DRY RUN] Would save and analyze CARFAX');
                }
              } else if (!matchedListing.carfaxReceived) {
                // Send CARFAX request
                console.log('    📄 No CARFAX - sending request...');

                if (!options.dryRun) {
                  const { subject, text } = generateEmail('carfax_request', { listing: matchedListing });
                  const emailMatch = email.from.match(/<(.+)>/) || [null, email.from];
                  const replyTo = emailMatch[1];

                  await emailClient.send({
                    to: replyTo,
                    subject: `Re: ${email.subject}`,
                    text,
                  });
                  console.log('    ✅ CARFAX request sent');
                } else {
                  console.log('    [DRY RUN] Would send CARFAX request');
                }
              }
            } else {
              console.log('    ❓ No matching listing');
            }
          }
        }

        emailClient.close();
        console.log(`\n✅ Processed ${results.emailsProcessed} emails, received ${results.carfaxReceived} CARFAX reports`);
      } catch (error) {
        console.error(`❌ Auto-respond failed: ${error}`);
      }
    } else {
      console.log('\n⏭️  PHASE 4: AUTO-RESPOND (skipped)\n');
    }

    // ═══════════════════════════════════════════════════════════════
    // SUMMARY
    // ═══════════════════════════════════════════════════════════════
    console.log('\n' + '='.repeat(60));
    console.log('📊 PIPELINE SUMMARY\n');
    console.log(`  Listings found:     ${results.searched} (${results.newListings} new)`);
    console.log(`  Listings analyzed:  ${results.analyzed}`);
    console.log(`  Sellers contacted:  ${results.contacted}`);
    console.log(`  Emails processed:   ${results.emailsProcessed}`);
    console.log(`  CARFAX received:    ${results.carfaxReceived}`);

    if (options.dryRun) {
      console.log('\n[DRY RUN - No actual actions taken]');
    }

    // Show next steps
    console.log('\n📋 NEXT STEPS:');
    console.log('  1. Run `npm run dev -- triage` to review interesting candidates');
    console.log('  2. Run `npm run dev -- export` to export for Claude analysis');
    console.log('  3. Run `npm run dev -- negotiate <id> --start` to begin price negotiation');
    console.log('');
  });
