/**
 * Email Follow-up Command (Flow 2)
 * Orchestrates the email follow-up workflow with Claude analysis
 */

import { Command } from 'commander';
import { getDatabase } from '../../database/index.js';
import { EmailClient, saveEmailAttachments } from '../../email/client.js';
import { extractLinksFromEmail, filterRelevantLinks, processEmailLinks } from '../../email/link-processor.js';
import { analyzeCarfaxBuffer } from '../../analyzers/carfax-analyzer.js';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { Listing, ConversationMessage } from '../../database/client.js';

const WORKSPACE_DIR = 'workspace';
const LISTINGS_DIR = path.join(WORKSPACE_DIR, 'listings');

/**
 * Get the workspace directory name for a listing
 */
function getListingDirName(listing: { id: number; year: number; make: string; model: string }): string {
  const slug = `${listing.year}-${listing.make}-${listing.model}`
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
  return `${String(listing.id).padStart(3, '0')}-${slug}`;
}

/**
 * Sync listing and all correspondence to workspace
 */
function syncListingWorkspace(listing: Listing): string {
  const dirName = getListingDirName(listing);
  const listingDir = path.join(LISTINGS_DIR, dirName);
  const emailsDir = path.join(listingDir, 'emails');
  const attachmentsDir = path.join(listingDir, 'attachments');

  fs.mkdirSync(emailsDir, { recursive: true });
  fs.mkdirSync(attachmentsDir, { recursive: true });

  // Write comprehensive listing.md
  const specs = listing.specs || {};
  const listingMd = `# ${listing.year} ${listing.make} ${listing.model}

## Vehicle Details

| Field | Value |
|-------|-------|
| **Price** | $${listing.price?.toLocaleString() || 'N/A'} |
| **Mileage** | ${listing.mileageKm?.toLocaleString() || 'N/A'} km |
| **VIN** | ${listing.vin || 'Not available'} |
| **Status** | ${listing.status} |
| **Score** | ${listing.score ?? 'Not scored'}/100 |

## Seller Information

| Field | Value |
|-------|-------|
| **Name** | ${listing.sellerName || 'Unknown'} |
| **Type** | ${listing.sellerType || 'Unknown'} |
| **Phone** | ${listing.sellerPhone || 'N/A'} |
| **Email** | ${listing.sellerEmail || 'N/A'} |
| **Location** | ${listing.city || ''}${listing.city && listing.province ? ', ' : ''}${listing.province || 'N/A'} |
| **Distance** | ${listing.distanceKm ?? 'N/A'} km |

## Vehicle Specifications

${Object.keys(specs).length > 0 ? Object.entries(specs).map(([k, v]) => `- **${k}:** ${v}`).join('\n') : 'No specifications available.'}

## Listing URL

${listing.sourceUrl}

## Description

${listing.description || 'No description available.'}

## Red Flags

${listing.redFlags?.map(f => `- ⚠️ ${f}`).join('\n') || 'None identified'}

## Notes

${listing.notes || 'None'}
`;

  fs.writeFileSync(path.join(listingDir, 'listing.md'), listingMd);

  // Write AI analysis if available
  if (listing.aiAnalysis) {
    try {
      const analysis = JSON.parse(listing.aiAnalysis);
      const analysisMd = `# AI Analysis

## Summary

${analysis.summary || 'No summary available.'}

## Score: ${analysis.recommendationScore ?? 'N/A'}/100

**Condition:** ${analysis.estimatedCondition || 'Unknown'}

## Positives

${analysis.positives?.map((p: string) => `- ✅ ${p}`).join('\n') || 'None identified'}

## Concerns

${analysis.concerns?.map((c: string) => `- ⚠️ ${c}`).join('\n') || 'None identified'}

## Pricing Analysis

${analysis.pricing ? `
- **Type:** ${analysis.pricing.pricingType}
- **Certification:** ${analysis.pricing.certificationStatus}
${analysis.pricing.mentionedFees?.length > 0 ? `- **Fees:** ${analysis.pricing.mentionedFees.map((f: any) => `${f.name}: $${f.amount || '?'}`).join(', ')}` : ''}
` : 'No pricing analysis available.'}
`;
      fs.writeFileSync(path.join(listingDir, 'analysis.md'), analysisMd);
    } catch {}
  }

  // Copy CARFAX
  if (listing.carfaxPath && fs.existsSync(listing.carfaxPath)) {
    fs.copyFileSync(listing.carfaxPath, path.join(listingDir, 'carfax.pdf'));
  }

  if (listing.carfaxSummary) {
    const carfaxMd = `# CARFAX Summary

${listing.carfaxSummary}

## Key Data

- **Accidents:** ${listing.accidentCount ?? 'Unknown'}
- **Previous Owners:** ${listing.ownerCount ?? 'Unknown'}
- **Service Records:** ${listing.serviceRecordCount ?? 'Unknown'}
`;
    fs.writeFileSync(path.join(listingDir, 'carfax-summary.md'), carfaxMd);
  }

  // Write conversation history
  if (listing.sellerConversation && listing.sellerConversation.length > 0) {
    let conversationMd = `# Conversation History

`;
    for (const msg of listing.sellerConversation) {
      const icon = msg.direction === 'outbound' ? '📤' : '📥';
      const label = msg.direction === 'outbound' ? 'SENT' : 'RECEIVED';
      conversationMd += `## ${icon} ${label}: ${msg.date}

**Channel:** ${msg.channel}
${msg.subject ? `**Subject:** ${msg.subject}` : ''}

---

${msg.body}

---

`;
    }
    fs.writeFileSync(path.join(listingDir, 'conversation.md'), conversationMd);

    // Also write individual emails
    let emailNum = 1;
    for (const msg of listing.sellerConversation) {
      const dateStr = msg.date.split('T')[0];
      const filename = `${String(emailNum).padStart(2, '0')}-${msg.direction}-${dateStr}.md`;
      const emailMd = `# ${msg.direction === 'outbound' ? 'Sent' : 'Received'}: ${msg.date}

**Channel:** ${msg.channel}
${msg.subject ? `**Subject:** ${msg.subject}` : ''}

---

${msg.body}
`;
      fs.writeFileSync(path.join(emailsDir, filename), emailMd);
      emailNum++;
    }
  }

  return listingDir;
}

/**
 * Check if an email should be skipped
 */
function shouldSkipEmail(email: { from: string; subject: string; text: string }): boolean {
  const fromLower = email.from.toLowerCase();
  const subjectLower = email.subject.toLowerCase();

  const skipPatterns = [
    'noreply', 'no-reply', 'donotreply', 'mailer-daemon', 'postmaster',
    'autoresponder', 'notification@', 'newsletter', 'unsubscribe',
    'price alert', 'similar vehicles', 'subscription',
  ];

  for (const pattern of skipPatterns) {
    if (fromLower.includes(pattern) || subjectLower.includes(pattern)) {
      return true;
    }
  }

  return false;
}

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
      fs.mkdirSync(LISTINGS_DIR, { recursive: true });

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
        if (shouldSkipEmail(email)) {
          continue;
        }

        // Try to match to a listing
        const matchedListing = listingsToCheck.find(listing => {
          if (listing.sellerEmail && email.from.toLowerCase().includes(listing.sellerEmail.toLowerCase())) return true;
          if (listing.sellerName && email.from.toLowerCase().includes(listing.sellerName.toLowerCase())) return true;
          const vehicle = `${listing.make} ${listing.model}`.toLowerCase();
          if (email.subject.toLowerCase().includes(vehicle)) return true;
          if (email.text.toLowerCase().includes(vehicle)) return true;
          return false;
        });

        if (!matchedListing) continue;

        matched++;
        const vehicle = `${matchedListing.year} ${matchedListing.make} ${matchedListing.model}`;
        console.log('─'.repeat(70));
        console.log(`📥 Email matched to #${matchedListing.id}: ${vehicle}`);
        console.log(`   From: ${email.from}`);
        console.log(`   Subject: ${email.subject}`);

        // Sync workspace
        const listingDir = syncListingWorkspace(matchedListing);

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
              accidentCount: analysis.data.accidentCount,
              ownerCount: analysis.data.ownerCount,
              serviceRecordCount: analysis.data.serviceRecordCount,
              carfaxSummary: analysis.summary,
            });
            console.log(`   ✅ CARFAX analyzed: ${analysis.riskLevel} risk`);
          } catch (e) {
            db.updateListing(matchedListing.id, { carfaxReceived: true, carfaxPath });
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
          status: 'negotiating',
        });

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
          continue;
        }

        // Re-sync workspace with updated data
        const refreshedListing = db.getListing(matchedListing.id);
        if (refreshedListing) {
          syncListingWorkspace(refreshedListing);
        }

        console.log(`   📁 Workspace synced: ${listingDir}`);
        console.log(`   💡 Run: npm run dev -- ask-claude ${matchedListing.id}`);
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
