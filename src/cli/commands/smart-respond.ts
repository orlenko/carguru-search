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
 * Read previous emails from workspace
 */
function readEmailHistory(listingDir: string): string {
  const emailsDir = path.join(listingDir, 'emails');
  if (!fs.existsSync(emailsDir)) return 'No previous correspondence.';

  const emailFiles = fs.readdirSync(emailsDir)
    .filter(f => f.endsWith('.md'))
    .sort();

  if (emailFiles.length === 0) return 'No previous correspondence.';

  const emails: string[] = [];
  for (const file of emailFiles) {
    const content = fs.readFileSync(path.join(emailsDir, file), 'utf-8');
    emails.push(`### ${file}\n${content}`);
  }

  return emails.join('\n\n');
}

/**
 * Read CARFAX summary if available
 */
function readCarfaxSummary(listingDir: string, listing: Listing): string {
  // Try carfax-summary.md first
  const summaryPath = path.join(listingDir, 'carfax-summary.md');
  if (fs.existsSync(summaryPath)) {
    return fs.readFileSync(summaryPath, 'utf-8');
  }

  // Fall back to database info
  if (listing.carfaxSummary) {
    return `## CARFAX Summary\n\n${listing.carfaxSummary}\n\n- Accidents: ${listing.accidentCount ?? 'Unknown'}\n- Owners: ${listing.ownerCount ?? 'Unknown'}\n- Service Records: ${listing.serviceRecordCount ?? 'Unknown'}`;
  }

  return 'CARFAX not yet received.';
}

/**
 * Invoke Claude to analyze email and get response
 */
async function analyzeWithClaude(
  listing: Listing,
  email: { from: string; subject: string; text: string; date?: Date },
  crossListingContext: string,
  listingDir: string,
  debug = false
): Promise<{ classification: string; action: string; response: string | null; reasoning: string }> {
  const vehicle = `${listing.year} ${listing.make} ${listing.model}`;

  if (debug) console.log('   [DEBUG] Building prompt with full context...');

  // Get current date/time for context
  const now = new Date();
  const currentDateTime = now.toLocaleString('en-CA', {
    timeZone: 'America/Toronto',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  // Get email date
  const emailDate = email.date
    ? email.date.toLocaleString('en-CA', {
        timeZone: 'America/Toronto',
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : 'Unknown date';

  // Read listing details
  const listingPath = path.join(listingDir, 'listing.md');
  const listingDetails = fs.existsSync(listingPath)
    ? fs.readFileSync(listingPath, 'utf-8')
    : `Vehicle: ${vehicle}\nPrice: $${listing.price?.toLocaleString()}\nMileage: ${listing.mileageKm?.toLocaleString()} km`;

  // Read email history
  const emailHistory = readEmailHistory(listingDir);

  // Read CARFAX
  const carfaxInfo = readCarfaxSummary(listingDir, listing);

  const prompt = `You are a car buying negotiator helping a buyer purchase a used minivan. Analyze the dealer's email and craft a strategic response.

## IMPORTANT: Current Date/Time
**Today is: ${currentDateTime}**

When the dealer mentions relative times like "tomorrow", "this weekend", "next week", interpret them relative to WHEN THE EMAIL WAS SENT, not today. Then translate to actual dates in your response.

---

## Listing Details

${listingDetails}

---

## CARFAX / Vehicle History

${carfaxInfo}

---

## Previous Correspondence

${emailHistory}

---

## Other Active Listings (for negotiation leverage)

${crossListingContext}

---

## NEW EMAIL TO ANALYZE

**Received:** ${emailDate}
**From:** ${email.from}
**Subject:** ${email.subject}

---
${email.text}
---

## Your Task

Analyze this email considering the full context above. Your goals:
1. Get CARFAX if we don't have it yet
2. Negotiate price down using market data, vehicle deficiencies, and competing offers
3. Leverage other listings when appropriate ("I'm also considering a similar vehicle listed at $X")
4. Identify any red flags that affect value or trustworthiness
5. Drive toward a purchase decision

Respond with this exact JSON structure:
{
  "classification": "available_with_carfax|available_no_carfax|sold|question|counter_offer|info_provided|follow_up|spam",
  "action": "request_carfax|make_offer|counter_offer|answer_question|schedule_viewing|mark_sold|ignore|needs_review",
  "reasoning": "Brief explanation of your analysis, noting any time-sensitive elements",
  "response": "The full email response to send, or null if no response needed. Keep it professional and concise. Sign as 'Vlad'."
}

Important:
- If car is sold, action should be "mark_sold" and response should be null
- If spam/irrelevant, action should be "ignore" and response should be null
- Always request CARFAX before negotiating price if we don't have it
- Be specific about dates/times - convert relative times to actual dates
- Be polite but firm on price`;

  if (debug) console.log('   [DEBUG] Spawning Claude CLI with Opus model...');

  return new Promise((resolve, reject) => {
    // Use --print flag for non-interactive mode
    // Use Opus model for best analysis quality
    // Pass prompt via stdin to handle long prompts safely
    const args = ['--print', '--model', 'opus'];

    if (debug) console.log(`   [DEBUG] Prompt length: ${prompt.length} chars, using opus model, passing via stdin`);

    const claude = spawn('claude', args, {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
    });

    // Write prompt to stdin and close it
    if (claude.stdin) {
      claude.stdin.write(prompt);
      claude.stdin.end();
    }

    let output = '';
    let errorOutput = '';

    // Add timeout (60 seconds)
    const timeout = setTimeout(() => {
      claude.kill();
      reject(new Error('Claude timed out after 60 seconds'));
    }, 60000);

    claude.stdout?.on('data', (data) => {
      const chunk = data.toString();
      output += chunk;
      if (debug) console.log(`   [DEBUG] stdout chunk: ${chunk.slice(0, 100)}...`);
    });

    claude.stderr?.on('data', (data) => {
      const chunk = data.toString();
      errorOutput += chunk;
      if (debug) console.log(`   [DEBUG] stderr: ${chunk}`);
    });

    claude.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to invoke Claude: ${err.message}`));
    });

    claude.on('exit', (code) => {
      clearTimeout(timeout);

      if (debug) {
        console.log(`   [DEBUG] Claude exited with code ${code}`);
        console.log(`   [DEBUG] Output length: ${output.length}`);
      }

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
          console.log('   [WARN] No JSON in response, raw output:');
          console.log(output.slice(0, 500));
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
  .option('--debug', 'Enable debug logging')
  .action(async (options) => {
    try {
      const db = getDatabase();
      const emailClient = new EmailClient();
      const dryRun = options.dryRun ?? false;
      const limit = parseInt(options.limit);
      const debug = options.debug ?? false;

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
            listingDir,
            debug
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
