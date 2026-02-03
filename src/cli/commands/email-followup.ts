/**
 * Email Follow-up Command (Flow 2)
 * Orchestrates the email follow-up workflow with Claude analysis
 */

import { Command } from 'commander';
import { getDatabase } from '../../database/index.js';
import { EmailClient, saveEmailAttachments } from '../../email/client.js';
import { extractLinksFromEmail, filterRelevantLinks, processEmailLinks } from '../../email/link-processor.js';
import { shouldSkipEmail } from '../../email/filters.js';
import { analyzeCarfaxBuffer } from '../../analyzers/carfax-analyzer.js';
import * as fs from 'fs';
import * as path from 'path';
import type { Listing, ConversationMessage } from '../../database/client.js';
import { matchListingFromEmail } from '../../email/matching.js';
import { syncListingToWorkspace, writeSearchContext } from '../../workspace/index.js';

export const emailFollowupCommand = new Command('email-followup')
  .description('Flow 2: Check emails and follow up with Claude-powered responses')
  .option('--listing <id>', 'Process emails for specific listing only')
  .option('--check-only', 'Only check for new emails, don\'t respond')
  .option('--status', 'Show status of all active conversations')
  .option('--dry-run', 'Analyze but don\'t send responses')
  .action(async (options) => {
    const db = getDatabase();

    // Status mode: show conversation status for all active listings
    if (options.status) {
      console.log('\n📧 Email Follow-up Status\n');
      console.log('─'.repeat(80));

      const activeStatuses = ['contacted', 'awaiting_response', 'negotiating'];
      const listings = db.listListings({ status: activeStatuses as any, limit: 100 });

      if (listings.length === 0) {
        console.log('No active conversations.');
        return;
      }

      console.log(`${'ID'.padEnd(4)} ${'Vehicle'.padEnd(28)} ${'Status'.padEnd(18)} ${'Last Contact'.padEnd(12)} CARFAX`);
      console.log('─'.repeat(80));

      for (const listing of listings) {
        const vehicle = `${listing.year} ${listing.make} ${listing.model}`.slice(0, 27);
        const lastContact = listing.lastSellerResponseAt
          ? listing.lastSellerResponseAt.split('T')[0]
          : listing.lastContactedAt?.split('T')[0] || 'Never';
        const carfax = listing.carfaxReceived ? '✅' : '❌';
        const msgCount = listing.sellerConversation?.length || 0;

        console.log(
          `${String(listing.id).padEnd(4)} ` +
          `${vehicle.padEnd(28)} ` +
          `${listing.status.padEnd(18)} ` +
          `${lastContact.padEnd(12)} ` +
          `${carfax} (${msgCount} msgs)`
        );
      }

      console.log('─'.repeat(80));
      console.log(`\nTotal: ${listings.length} active conversations`);
      return;
    }

    // Main email processing
    console.log('\n📧 Email Follow-up Flow\n');

    try {
      const emailClient = new EmailClient();
      writeSearchContext();
      const processedEmailIds = db.getProcessedEmailIds();

      // Get listings to check
      let listingsToCheck: Listing[];
      if (options.listing) {
        const listing = db.getListing(parseInt(options.listing));
        if (!listing) {
          console.error(`Listing #${options.listing} not found`);
          process.exit(1);
        }
        listingsToCheck = [listing];
      } else {
        // Get all contacted/negotiating listings
        listingsToCheck = db.listListings({
          status: ['contacted', 'awaiting_response', 'negotiating'] as any,
          limit: 100
        });
      }

      if (listingsToCheck.length === 0) {
        console.log('No active listings to check emails for.');
        return;
      }

      console.log(`Checking emails for ${listingsToCheck.length} listing(s)...\n`);

      // Fetch new emails
      const emails = await emailClient.fetchNewEmails();
      console.log(`Found ${emails.length} new email(s)\n`);

      if (emails.length === 0) {
        emailClient.close();
        console.log('No new emails to process.');
        return;
      }

      let processed = 0;
      let matched = 0;
      let responded = 0;

      for (const email of emails) {
        if (email.messageId && processedEmailIds.has(email.messageId)) {
          continue;
        }

        if (shouldSkipEmail(email).skip) {
          if (!options.dryRun && email.messageId) {
            db.markEmailProcessed({
              messageId: email.messageId,
              fromAddress: email.from,
              subject: email.subject,
              action: 'skipped',
            });
            processedEmailIds.add(email.messageId);
          }
          continue;
        }

        // Try to match to a listing
        const matchedListing = matchListingFromEmail(email, listingsToCheck);

        if (!matchedListing) continue;

        matched++;
        const vehicle = `${matchedListing.year} ${matchedListing.make} ${matchedListing.model}`;
        console.log('─'.repeat(70));
        console.log(`📥 Email matched to #${matchedListing.id}: ${vehicle}`);
        console.log(`   From: ${email.from}`);
        console.log(`   Subject: ${email.subject}`);

        // Sync workspace
        const listingDir = syncListingToWorkspace(matchedListing);

        // Save email attachments
        if (email.attachments.length > 0) {
          console.log(`   📎 ${email.attachments.length} attachment(s)`);
          const saved = await saveEmailAttachments(email, matchedListing.id);
          for (const att of saved) {
            console.log(`      Saved: ${att.filename} [${att.type}]`);
          }
        }

        // Check for CARFAX
        const carfaxAttachment = email.attachments.find(a =>
          a.contentType === 'application/pdf' &&
          (a.filename.toLowerCase().includes('carfax') ||
           a.filename.toLowerCase().includes('history') ||
           a.filename.toLowerCase().includes('report'))
        );

        if (carfaxAttachment && !matchedListing.carfaxReceived) {
          console.log(`   📄 CARFAX detected - analyzing...`);
          const carfaxDir = path.join('data', 'carfax');
          fs.mkdirSync(carfaxDir, { recursive: true });
          const carfaxPath = path.join(carfaxDir, `listing-${matchedListing.id}.pdf`);
          fs.writeFileSync(carfaxPath, carfaxAttachment.content);

          try {
            const analysis = await analyzeCarfaxBuffer(carfaxAttachment.content);
            db.updateListing(matchedListing.id, {
              carfaxReceived: true,
              carfaxPath,
              infoStatus: 'carfax_received',
              accidentCount: analysis.data.accidentCount,
              ownerCount: analysis.data.ownerCount,
              serviceRecordCount: analysis.data.serviceRecordCount,
              carfaxSummary: analysis.summary,
            });
            console.log(`   ✅ CARFAX analyzed: ${analysis.riskLevel} risk`);
          } catch (e) {
            db.updateListing(matchedListing.id, {
              carfaxReceived: true,
              carfaxPath,
              infoStatus: 'carfax_received',
            });
            console.log(`   ⚠️ CARFAX saved but analysis failed`);
          }
        }

        // Process links
        const links = extractLinksFromEmail(email);
        const relevantLinks = filterRelevantLinks(links);
        if (relevantLinks.length > 0) {
          console.log(`   🔗 ${relevantLinks.length} link(s) found`);
          try {
            const linkResults = await processEmailLinks(email, matchedListing);
            if (linkResults.enrichedData && Object.keys(linkResults.enrichedData).length > 0) {
              db.updateListing(matchedListing.id, linkResults.enrichedData);
              console.log(`   ✅ Extracted: ${Object.keys(linkResults.enrichedData).join(', ')}`);
            }
          } catch {}
        }

        // Save to conversation history
        const newMessage: ConversationMessage = {
          date: email.date?.toISOString() || new Date().toISOString(),
          direction: 'inbound',
          channel: 'email',
          subject: email.subject,
          body: email.text,
          attachments: email.attachments.map(a => a.filename),
        };
        const existingConversation = matchedListing.sellerConversation || [];
        db.updateListing(matchedListing.id, {
          sellerConversation: [...existingConversation, newMessage],
          lastSellerResponseAt: new Date().toISOString(),
        });
        if (!options.dryRun) {
          const transitionResult = db.transitionStatePath(matchedListing.id, 'negotiating', {
            triggeredBy: 'system',
            reasoning: 'Received seller response',
          });
          if (!transitionResult.success) {
            console.log(`   ⚠️ State transition failed: ${transitionResult.error}`);
          }
        }

        // Log audit
        db.logAudit({
          listingId: matchedListing.id,
          action: 'email_received',
          description: `Email received: ${email.subject}`,
          context: {
            from: email.from,
            hasAttachments: email.attachments.length > 0,
            linksFound: relevantLinks.length,
          },
          triggeredBy: 'system',
        });

        processed++;

        if (options.checkOnly) {
          console.log('   ℹ️ Check-only mode - no response generated');
          if (!options.dryRun && email.messageId) {
            db.markEmailProcessed({
              messageId: email.messageId,
              listingId: matchedListing.id,
              fromAddress: email.from,
              subject: email.subject,
              action: 'checked_only',
            });
            processedEmailIds.add(email.messageId);
          }
          continue;
        }

        // Re-sync workspace with updated data
        const refreshedListing = db.getListing(matchedListing.id);
        if (refreshedListing) {
          syncListingToWorkspace(refreshedListing);
        }

        console.log(`   📁 Workspace synced: ${listingDir}`);
        console.log(`   💡 Run: npm run dev -- ask-claude ${matchedListing.id}`);

        if (!options.dryRun && email.messageId) {
          db.markEmailProcessed({
            messageId: email.messageId,
            listingId: matchedListing.id,
            fromAddress: email.from,
            subject: email.subject,
            action: 'processed',
          });
          processedEmailIds.add(email.messageId);
        }
      }

      emailClient.close();

      console.log('\n' + '═'.repeat(70));
      console.log('Email Follow-up Summary:');
      console.log(`  Emails processed: ${processed}`);
      console.log(`  Matched to listings: ${matched}`);
      console.log(`  Responses sent: ${responded}`);

      if (options.checkOnly) {
        console.log('\n[CHECK-ONLY MODE - Run smart-respond to send replies]');
      }

    } catch (error) {
      console.error('Email follow-up failed:', error);
      process.exit(1);
    }
  });
