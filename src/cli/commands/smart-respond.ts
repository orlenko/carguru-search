import { Command } from 'commander';
import { getDatabase } from '../../database/index.js';
import { EmailClient } from '../../email/client.js';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { Listing } from '../../database/client.js';

const WORKSPACE_DIR = 'workspace';
const LISTINGS_DIR = path.join(WORKSPACE_DIR, 'listings');

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
    'mailer-daemon', 'postmaster', 'autoresponder', 'auto-reply',
    'automated', 'notification@', 'notifications@', 'alert@',
    'alerts@', 'system@', 'admin@', 'support@',
  ];
  for (const pattern of automatedPatterns) {
    if (fromLower.includes(pattern)) {
      return { skip: true, reason: `automated address (${pattern})` };
    }
  }

  // Skip marketing/newsletter subjects
  const marketingSubjects = [
    'subscription confirmed', 'you\'re subscribed', 'welcome to',
    'thank you for signing up', 'price alert', 'price drop',
    'similar vehicles', 'new listings', 'unsubscribe',
    'weekly digest', 'daily digest', 'newsletter',
  ];
  for (const pattern of marketingSubjects) {
    if (subjectLower.includes(pattern)) {
      return { skip: true, reason: `marketing email (${pattern})` };
    }
  }

  return { skip: false, reason: '' };
}

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
 * Sync a listing to the workspace
 */
function syncListingToWorkspace(listing: Listing): string {
  const dirName = getListingDirName(listing);
  const listingDir = path.join(LISTINGS_DIR, dirName);
  const emailsDir = path.join(listingDir, 'emails');
  const attachmentsDir = path.join(listingDir, 'attachments');

  fs.mkdirSync(emailsDir, { recursive: true });
  fs.mkdirSync(attachmentsDir, { recursive: true });

  // Write listing.md
  const listingMd = `# ${listing.year} ${listing.make} ${listing.model}

## Quick Facts

| Field | Value |
|-------|-------|
| **Price** | $${listing.price?.toLocaleString() || 'N/A'} |
| **Mileage** | ${listing.mileageKm?.toLocaleString() || 'N/A'} km |
| **Location** | ${listing.city || ''}${listing.city && listing.province ? ', ' : ''}${listing.province || 'N/A'} |
| **Seller** | ${listing.sellerName || 'Unknown'} |
| **Seller Type** | ${listing.sellerType || 'Unknown'} |
| **VIN** | ${listing.vin || 'N/A'} |
| **Status** | ${listing.status} |

## Seller Contact

- **Phone:** ${listing.sellerPhone || 'N/A'}
- **Email:** ${listing.sellerEmail || 'N/A'}

## Listing URL

${listing.sourceUrl}

## Description

${listing.description || 'No description available.'}

## Notes

${listing.notes || 'None'}
`;

  fs.writeFileSync(path.join(listingDir, 'listing.md'), listingMd);

  // Write analysis.md if we have AI analysis
  if (listing.aiAnalysis) {
    try {
      const analysis = JSON.parse(listing.aiAnalysis);
      const analysisMd = `# AI Analysis

## Summary

${analysis.summary || 'No summary available.'}

## Score

**Overall Score:** ${analysis.score || 'N/A'}/100

## Red Flags

${analysis.redFlags?.map((f: string) => `- ${f}`).join('\n') || 'None identified'}

## Positive Factors

${analysis.positives?.map((p: string) => `- ${p}`).join('\n') || 'None identified'}

## Recommendation

${analysis.recommendation || 'No recommendation available.'}
`;
      fs.writeFileSync(path.join(listingDir, 'analysis.md'), analysisMd);
    } catch {
      // Invalid JSON, skip
    }
  }

  // Copy CARFAX if exists
  if (listing.carfaxPath && fs.existsSync(listing.carfaxPath)) {
    fs.copyFileSync(listing.carfaxPath, path.join(listingDir, 'carfax.pdf'));
  }

  if (listing.carfaxSummary) {
    const carfaxMd = `# CARFAX Summary

${listing.carfaxSummary}

## Key Data

- **Accidents:** ${listing.accidentCount ?? 'Unknown'}
- **Owners:** ${listing.ownerCount ?? 'Unknown'}
- **Service Records:** ${listing.serviceRecordCount ?? 'Unknown'}
`;
    fs.writeFileSync(path.join(listingDir, 'carfax-summary.md'), carfaxMd);
  }

  return listingDir;
}

/**
 * Save an email to the workspace
 */
function saveEmailToWorkspace(
  listingDir: string,
  email: { from: string; subject: string; text: string; date?: Date },
  direction: 'inbound' | 'outbound'
): string {
  const emailsDir = path.join(listingDir, 'emails');
  fs.mkdirSync(emailsDir, { recursive: true });

  const existingEmails = fs.readdirSync(emailsDir).filter(f => f.endsWith('.md'));
  const nextNum = existingEmails.length + 1;
  const dateStr = (email.date || new Date()).toISOString().split('T')[0];
  const filename = `${String(nextNum).padStart(2, '0')}-${direction}-${dateStr}.md`;

  const emailMd = `# ${direction === 'outbound' ? 'Sent' : 'Received'}: ${(email.date || new Date()).toISOString()}

**From:** ${email.from}
**Subject:** ${email.subject}

---

${email.text}
`;

  const filepath = path.join(emailsDir, filename);
  fs.writeFileSync(filepath, emailMd);
  return filepath;
}

/**
 * Build context summary of all active listings for cross-leverage
 */
function buildCrossListingContext(db: ReturnType<typeof getDatabase>): string {
  const contacted = db.listListings({ status: 'contacted', limit: 50 });

  if (contacted.length === 0) {
    return 'No other active listings.';
  }

  const lines = ['## Other Active Listings (for leverage)\n'];

  for (const listing of contacted) {
    const hasCarfax = listing.carfaxReceived ? '✓ CARFAX' : '○ No CARFAX';
    const accidents = listing.accidentCount !== null ? `${listing.accidentCount} accidents` : '';
    lines.push(`- **#${listing.id}** ${listing.year} ${listing.make} ${listing.model}: $${listing.price?.toLocaleString()} | ${listing.mileageKm?.toLocaleString()} km | ${hasCarfax} ${accidents}`);
  }

  return lines.join('\n');
}

/**
 * Invoke Claude to analyze email and get response
 */
async function analyzeWithClaude(
  listing: Listing,
  email: { from: string; subject: string; text: string },
  crossListingContext: string,
  listingDir: string
): Promise<{ classification: string; action: string; response: string | null; reasoning: string }> {
  const vehicle = `${listing.year} ${listing.make} ${listing.model}`;

  const prompt = `You are a car buying negotiator. Analyze this dealer email and respond with ONLY valid JSON.

## Current Listing
- **Vehicle:** ${vehicle}
- **Asking Price:** $${listing.price?.toLocaleString()}
- **Mileage:** ${listing.mileageKm?.toLocaleString()} km
- **Seller:** ${listing.sellerName || 'Unknown'} (${listing.sellerType || 'unknown'})
- **CARFAX Received:** ${listing.carfaxReceived ? 'Yes' : 'No'}
- **Accidents:** ${listing.accidentCount ?? 'Unknown'}
- **Listing Directory:** ${listingDir}

${crossListingContext}

## Email from Dealer

**From:** ${email.from}
**Subject:** ${email.subject}

${email.text}

---

## Your Task

Analyze this email and decide how to respond. Your goals:
1. Get CARFAX if we don't have it
2. Negotiate price down using market data and deficiencies
3. Leverage other listings ("I'm also looking at a similar vehicle for $X less")
4. Identify red flags that affect value
5. Drive toward a purchase decision

Respond with this exact JSON structure:
{
  "classification": "available_with_carfax|available_no_carfax|sold|question|counter_offer|info_provided|follow_up|spam",
  "action": "request_carfax|make_offer|counter_offer|answer_question|schedule_viewing|mark_sold|ignore|needs_review",
  "reasoning": "Brief explanation of your analysis and strategy",
  "response": "The full email response to send, or null if no response needed. Keep it professional and concise. Sign as the buyer."
}

Important:
- If car is sold, action should be "mark_sold" and response should be null
- If spam/irrelevant, action should be "ignore" and response should be null
- Always request CARFAX before negotiating price if we don't have it
- Reference specific comparable listings when negotiating
- Be polite but firm on price`;

  return new Promise((resolve, reject) => {
    const claude = spawn('claude', ['-p', prompt, '--output-format', 'text'], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let output = '';
    let errorOutput = '';

    claude.stdout?.on('data', (data) => {
      output += data.toString();
    });

    claude.stderr?.on('data', (data) => {
      errorOutput += data.toString();
    });

    claude.on('error', (err) => {
      reject(new Error(`Failed to invoke Claude: ${err.message}`));
    });

    claude.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`Claude exited with code ${code}: ${errorOutput}`));
        return;
      }

      try {
        // Find JSON in output
        const jsonMatch = output.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const result = JSON.parse(jsonMatch[0]);
          resolve({
            classification: result.classification || 'unknown',
            action: result.action || 'needs_review',
            response: result.response || null,
            reasoning: result.reasoning || '',
          });
        } else {
          reject(new Error('No JSON found in Claude response'));
        }
      } catch (e) {
        reject(new Error(`Failed to parse Claude response: ${e}`));
      }
    });
  });
}

export const smartRespondCommand = new Command('smart-respond')
  .description('AI-powered automatic response to dealer emails')
  .option('--dry-run', 'Analyze emails but don\'t send responses')
  .option('--limit <n>', 'Max emails to process', '10')
  .action(async (options) => {
    try {
      const db = getDatabase();
      const emailClient = new EmailClient();
      const dryRun = options.dryRun ?? false;
      const limit = parseInt(options.limit);

      console.log('\n🤖 Smart Auto-Respond\n');
      console.log('Checking for new emails...');

      // Ensure workspace exists
      fs.mkdirSync(LISTINGS_DIR, { recursive: true });

      // Fetch new emails
      const emails = await emailClient.fetchNewEmails();

      if (emails.length === 0) {
        console.log('No new emails to process.');
        emailClient.close();
        return;
      }

      console.log(`Found ${emails.length} new email(s)\n`);

      // Get contacted listings for matching
      const contactedListings = db.listListings({ status: 'contacted', limit: 100 });

      // Build cross-listing context once
      const crossListingContext = buildCrossListingContext(db);

      let processed = 0;
      let responded = 0;
      let skipped = 0;
      let sold = 0;

      for (const email of emails.slice(0, limit)) {
        console.log('─'.repeat(70));
        console.log(`From: ${email.from}`);
        console.log(`Subject: ${email.subject}`);

        // Check if we should skip this email
        const skipCheck = shouldSkipEmail(email);
        if (skipCheck.skip) {
          console.log(`⏭️  Skipping: ${skipCheck.reason}`);
          skipped++;
          continue;
        }

        // Try to match email to a listing
        const matchedListing = contactedListings.find(listing => {
          if (listing.sellerEmail && email.from.toLowerCase().includes(listing.sellerEmail.toLowerCase())) return true;
          if (listing.sellerName && email.from.toLowerCase().includes(listing.sellerName.toLowerCase())) return true;
          const vehicle = `${listing.make} ${listing.model}`.toLowerCase();
          if (email.subject.toLowerCase().includes(vehicle)) return true;
          if (email.text.toLowerCase().includes(vehicle)) return true;
          return false;
        });

        if (!matchedListing) {
          console.log('❓ Could not match to any listing - skipping');
          skipped++;
          continue;
        }

        const vehicle = `${matchedListing.year} ${matchedListing.make} ${matchedListing.model}`;
        console.log(`✅ Matched: #${matchedListing.id} ${vehicle}`);

        // Sync listing to workspace
        const listingDir = syncListingToWorkspace(matchedListing);

        // Save inbound email to workspace
        saveEmailToWorkspace(listingDir, email, 'inbound');

        // Check for CARFAX attachment first
        const carfaxAttachment = email.attachments.find(
          a => a.contentType === 'application/pdf' &&
               (a.filename.toLowerCase().includes('carfax') ||
                a.filename.toLowerCase().includes('history'))
        );

        if (carfaxAttachment) {
          console.log('📄 CARFAX detected - saving...');
          const carfaxDir = path.join('data', 'carfax');
          fs.mkdirSync(carfaxDir, { recursive: true });
          const carfaxPath = path.join(carfaxDir, `listing-${matchedListing.id}.pdf`);
          fs.writeFileSync(carfaxPath, carfaxAttachment.content);
          fs.copyFileSync(carfaxPath, path.join(listingDir, 'carfax.pdf'));

          db.updateListing(matchedListing.id, {
            carfaxReceived: true,
            carfaxPath,
          });
          console.log(`   Saved: ${carfaxPath}`);
        }

        // Invoke Claude for analysis
        console.log('🧠 Analyzing with Claude...');

        try {
          const analysis = await analyzeWithClaude(
            matchedListing,
            email,
            crossListingContext,
            listingDir
          );

          console.log(`   Classification: ${analysis.classification}`);
          console.log(`   Action: ${analysis.action}`);
          console.log(`   Reasoning: ${analysis.reasoning}`);

          // Handle special actions
          if (analysis.action === 'mark_sold') {
            console.log('🚫 Car sold - marking as unavailable');
            db.updateListing(matchedListing.id, { status: 'rejected' });
            sold++;
            continue;
          }

          if (analysis.action === 'ignore' || !analysis.response) {
            console.log('⏭️  No response needed');
            skipped++;
            continue;
          }

          // We have a response to send
          console.log('\n📧 Draft Response:');
          console.log('─'.repeat(40));
          console.log(analysis.response);
          console.log('─'.repeat(40));

          if (dryRun) {
            console.log('[DRY RUN - Not sending]');
          } else {
            // Extract email address
            const emailMatch = email.from.match(/<(.+)>/) || [null, email.from];
            const replyTo = emailMatch[1];

            // Send the response
            await emailClient.send({
              to: replyTo,
              subject: `Re: ${email.subject}`,
              text: analysis.response,
            });

            console.log(`✅ Response sent to ${replyTo}`);

            // Save outbound email to workspace
            saveEmailToWorkspace(listingDir, {
              from: 'Buyer',
              subject: `Re: ${email.subject}`,
              text: analysis.response,
            }, 'outbound');

            responded++;
          }

        } catch (claudeError) {
          console.log(`❌ Claude analysis failed: ${claudeError}`);
          console.log('   Email saved to workspace for manual review');
        }

        processed++;
      }

      emailClient.close();

      console.log('\n' + '═'.repeat(70));
      console.log('Smart Respond Summary:');
      console.log(`  Processed: ${processed}`);
      console.log(`  Responded: ${responded}`);
      console.log(`  Skipped: ${skipped}`);
      console.log(`  Marked Sold: ${sold}`);

      if (dryRun) {
        console.log('\n[DRY RUN - No emails were actually sent]');
      }

    } catch (error) {
      console.error('Smart respond failed:', error);
      process.exit(1);
    }
  });

export const recommendCommand = new Command('recommend')
  .description('Get Claude\'s recommendation on which car to buy')
  .option('--budget <amount>', 'Maximum budget', '18000')
  .action(async (options) => {
    try {
      const db = getDatabase();
      const budget = parseInt(options.budget);

      console.log('\n🏆 Getting Purchase Recommendation\n');

      // Get all contacted listings with CARFAX
      const listings = db.listListings({ status: 'contacted', limit: 100 });
      const withCarfax = listings.filter(l => l.carfaxReceived);

      if (withCarfax.length === 0) {
        console.log('No listings with CARFAX received yet.');
        console.log('Wait for dealers to send CARFAX reports before getting recommendations.');
        return;
      }

      // Build detailed context
      const listingDetails = withCarfax.map(l => {
        return `
### #${l.id}: ${l.year} ${l.make} ${l.model}
- **Price:** $${l.price?.toLocaleString()}
- **Mileage:** ${l.mileageKm?.toLocaleString()} km
- **Location:** ${l.city}, ${l.province}
- **Seller:** ${l.sellerName} (${l.sellerType})
- **Accidents:** ${l.accidentCount ?? 'Unknown'}
- **Owners:** ${l.ownerCount ?? 'Unknown'}
- **CARFAX Summary:** ${l.carfaxSummary || 'Not analyzed'}
- **Notes:** ${l.notes || 'None'}
`;
      }).join('\n');

      const prompt = `You are a car buying advisor. Based on the listings below, recommend which car to buy.

## Budget
Maximum: $${budget.toLocaleString()}

## Listings with CARFAX Received

${listingDetails}

## Your Task

Analyze all listings and provide:
1. **Top Pick** - The best car to buy and why
2. **Runner Up** - Second choice if top pick falls through
3. **Avoid** - Any listings to avoid and why
4. **Negotiation Target** - What price to aim for on top pick

Respond in markdown format with clear sections.`;

      console.log('Analyzing listings with Claude...\n');

      const claude = spawn('claude', ['-p', prompt], {
        cwd: WORKSPACE_DIR,
        stdio: 'inherit',
      });

      claude.on('error', (err) => {
        console.error('Failed to invoke Claude:', err);
        process.exit(1);
      });

    } catch (error) {
      console.error('Recommendation failed:', error);
      process.exit(1);
    }
  });
