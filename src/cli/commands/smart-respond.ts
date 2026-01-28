import { Command } from 'commander';
import { getDatabase } from '../../database/index.js';
import { EmailClient, saveEmailAttachments } from '../../email/client.js';
import { extractLinksFromEmail, filterRelevantLinks, processEmailLinks } from '../../email/link-processor.js';
import { shouldSkipEmail } from '../../email/filters.js';
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

  // Copy CARFAX if exists (could be a PDF file or a directory of images)
  if (listing.carfaxPath && fs.existsSync(listing.carfaxPath)) {
    const carfaxStat = fs.statSync(listing.carfaxPath);
    if (carfaxStat.isDirectory()) {
      // It's a directory of CARFAX images - copy all files
      const carfaxImagesDir = path.join(listingDir, 'carfax-images');
      fs.mkdirSync(carfaxImagesDir, { recursive: true });
      const files = fs.readdirSync(listing.carfaxPath);
      for (const file of files) {
        const srcPath = path.join(listing.carfaxPath, file);
        const destPath = path.join(carfaxImagesDir, file);
        if (fs.statSync(srcPath).isFile()) {
          fs.copyFileSync(srcPath, destPath);
        }
      }
    } else {
      // It's a PDF file
      fs.copyFileSync(listing.carfaxPath, path.join(listingDir, 'carfax.pdf'));
    }
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
  attachmentInfo: string,
  carfaxJustReceived: boolean,
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

  // Read CARFAX - note if just received
  let carfaxInfo = readCarfaxSummary(listingDir, listing);
  if (carfaxJustReceived) {
    carfaxInfo = `**CARFAX/VEHICLE REPORT JUST RECEIVED WITH THIS EMAIL**\n\nThe report PDF has been saved. You should acknowledge receipt and proceed with negotiation.\n\n` + carfaxInfo;
  }

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
${attachmentInfo}
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
- Be polite but firm on price
- NEVER include a phone number in responses - only sign with name "Vlad"
- Do NOT make up or hallucinate any contact information`;

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
  .option('--include-read', 'Also check read emails (reprocess previously seen emails)')
  .option('--since <days>', 'Only check emails from last N days when using --include-read', '3')
  .action(async (options) => {
    try {
      const db = getDatabase();
      const emailClient = new EmailClient();
      const dryRun = options.dryRun ?? false;
      const limit = parseInt(options.limit);
      const debug = options.debug ?? false;
      const includeRead = options.includeRead ?? false;
      const sinceDays = parseInt(options.since);

      console.log('\n🤖 Smart Auto-Respond\n');
      if (includeRead) {
        console.log(`Checking all emails from last ${sinceDays} days (including read)...`);
      } else {
        console.log('Checking for new emails...');
      }

      // Ensure workspace exists
      fs.mkdirSync(LISTINGS_DIR, { recursive: true });

      // Fetch emails - optionally include read emails
      const since = includeRead ? new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000) : undefined;
      const emails = await emailClient.fetchNewEmails(since, includeRead);

      if (emails.length === 0) {
        console.log(includeRead ? 'No emails found in the specified time range.' : 'No new emails to process.');
        emailClient.close();
        return;
      }

      console.log(`Found ${emails.length} email(s) to process\n`);

      // Get all active listings for matching (emails can come for any active listing, not just 'contacted')
      const activeStatuses = ['contacted', 'awaiting_response', 'negotiating', 'viewing_scheduled', 'inspected'] as const;
      const contactedListings = db.listListings({ status: activeStatuses as any, limit: 200 });

      // Build cross-listing context once
      const crossListingContext = buildCrossListingContext(db);

      let processed = 0;
      let responded = 0;
      let skipped = 0;
      let sold = 0;
      let duplicates = 0;

      // Pre-load processed email IDs for efficiency
      const processedEmailIds = db.getProcessedEmailIds();

      for (const email of emails.slice(0, limit)) {
        console.log('─'.repeat(70));
        console.log(`From: ${email.from}`);
        console.log(`Subject: ${email.subject}`);

        // Check for duplicate (already processed email)
        if (email.messageId && processedEmailIds.has(email.messageId)) {
          console.log(`⏭️  Already processed (duplicate) - skipping`);
          duplicates++;
          continue;
        }

        // Check if we should skip this email
        const skipCheck = shouldSkipEmail(email);
        if (skipCheck.skip) {
          console.log(`⏭️  Skipping: ${skipCheck.reason}`);
          // Mark as processed even if skipped, so we don't check it again
          if (email.messageId) {
            db.markEmailProcessed({
              messageId: email.messageId,
              fromAddress: email.from,
              subject: email.subject,
              action: `skipped: ${skipCheck.reason}`,
            });
          }
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
          // Mark as processed so we don't re-check this email
          if (email.messageId) {
            db.markEmailProcessed({
              messageId: email.messageId,
              fromAddress: email.from,
              subject: email.subject,
              action: 'skipped: no matching listing',
            });
          }
          skipped++;
          continue;
        }

        const vehicle = `${matchedListing.year} ${matchedListing.make} ${matchedListing.model}`;
        console.log(`✅ Matched: #${matchedListing.id} ${vehicle}`);

        // Sync listing to workspace
        const listingDir = syncListingToWorkspace(matchedListing);

        // Save inbound email to workspace
        saveEmailToWorkspace(listingDir, email, 'inbound');

        // Log all attachments for debugging
        if (email.attachments.length > 0) {
          console.log(`   📎 ${email.attachments.length} attachment(s):`);
          for (const att of email.attachments) {
            const sizeKb = Math.round(att.content.length / 1024);
            console.log(`      - ${att.filename} (${att.contentType}, ${sizeKb}KB)`);
          }
        }

        // Check for attachments - PDFs and images
        const pdfAttachments = email.attachments.filter(
          a => a.contentType === 'application/pdf'
        );
        const imageAttachments = email.attachments.filter(
          a => a.contentType.startsWith('image/') && a.content.length > 50000 // >50KB = likely real photo, not signature
        );

        // Build attachment info string for Claude
        let attachmentInfo = '';
        if (email.attachments.length > 0) {
          attachmentInfo = '\n## Attachments in this email\n';
          for (const att of email.attachments) {
            const sizeKb = Math.round(att.content.length / 1024);
            attachmentInfo += `- ${att.filename} (${att.contentType}, ${sizeKb}KB)\n`;
          }
        }

        // Check for CARFAX/vehicle report - be more inclusive with detection
        const carfaxAttachment = pdfAttachments.find(
          a => a.filename.toLowerCase().includes('carfax') ||
               a.filename.toLowerCase().includes('history') ||
               a.filename.toLowerCase().includes('report') ||
               a.filename.toLowerCase().includes('vehicle')
        );

        // Check if images might be CARFAX pages (multiple large images or name contains carfax)
        const carfaxImages = imageAttachments.filter(
          a => a.filename.toLowerCase().includes('carfax') ||
               a.filename.toLowerCase().includes('history') ||
               a.filename.toLowerCase().includes('report') ||
               a.filename.toLowerCase().includes('page')
        );
        const hasCarfaxImages = carfaxImages.length > 0 ||
          (imageAttachments.length >= 2 &&
           (email.text.toLowerCase().includes('carfax') ||
            email.text.toLowerCase().includes('report') ||
            email.text.toLowerCase().includes('history')));

        // If no name match but there's a PDF and email mentions carfax/report, assume it's the report
        const possibleCarfax = carfaxAttachment || (
          pdfAttachments.length > 0 &&
          (email.text.toLowerCase().includes('carfax') ||
           email.text.toLowerCase().includes('report') ||
           email.text.toLowerCase().includes('attached') ||
           email.subject.toLowerCase().includes('report'))
        ) ? pdfAttachments[0] : null;

        let carfaxJustReceived = false;

        // Save PDF CARFAX
        if (possibleCarfax) {
          console.log(`   📄 Vehicle report PDF detected: ${possibleCarfax.filename} - saving...`);
          const carfaxDir = path.join('data', 'carfax');
          fs.mkdirSync(carfaxDir, { recursive: true });
          const carfaxPath = path.join(carfaxDir, `listing-${matchedListing.id}.pdf`);
          fs.writeFileSync(carfaxPath, possibleCarfax.content);
          fs.copyFileSync(carfaxPath, path.join(listingDir, 'carfax.pdf'));

          db.updateListing(matchedListing.id, {
            carfaxReceived: true,
            carfaxPath,
          });
          console.log(`      Saved: ${carfaxPath}`);
          carfaxJustReceived = true;

          // Also write a note about receiving it
          const carfaxNote = `\n## CARFAX/Vehicle Report\n\n**Just received with this email:** ${possibleCarfax.filename}\n\nThe PDF has been saved but not yet analyzed. Treat this as CARFAX received.`;
          fs.writeFileSync(path.join(listingDir, 'carfax-received.md'), carfaxNote);
          attachmentInfo += `\n**NOTE: Vehicle history report (PDF) received and saved.**\n`;
        }

        // Save CARFAX images if detected
        if (!carfaxJustReceived && hasCarfaxImages) {
          console.log(`   📄 Vehicle report IMAGES detected (${imageAttachments.length} images) - saving...`);
          const carfaxDir = path.join('data', 'carfax');
          const imagesDir = path.join(carfaxDir, `listing-${matchedListing.id}-images`);
          fs.mkdirSync(imagesDir, { recursive: true });

          let imageNum = 1;
          for (const img of imageAttachments) {
            const ext = img.contentType.split('/')[1] || 'jpg';
            const imgPath = path.join(imagesDir, `page-${String(imageNum).padStart(2, '0')}.${ext}`);
            fs.writeFileSync(imgPath, img.content);
            console.log(`      Saved: ${imgPath}`);
            imageNum++;
          }

          // Also copy to workspace
          const workspaceImagesDir = path.join(listingDir, 'carfax-images');
          fs.mkdirSync(workspaceImagesDir, { recursive: true });
          imageNum = 1;
          for (const img of imageAttachments) {
            const ext = img.contentType.split('/')[1] || 'jpg';
            const imgPath = path.join(workspaceImagesDir, `page-${String(imageNum).padStart(2, '0')}.${ext}`);
            fs.writeFileSync(imgPath, img.content);
            imageNum++;
          }

          db.updateListing(matchedListing.id, {
            carfaxReceived: true,
            carfaxPath: imagesDir,
          });
          carfaxJustReceived = true;

          const carfaxNote = `\n## CARFAX/Vehicle Report\n\n**Just received as ${imageAttachments.length} image(s) with this email.**\n\nImages saved to: ${imagesDir}\n\nTreat this as CARFAX received - review the images manually.`;
          fs.writeFileSync(path.join(listingDir, 'carfax-received.md'), carfaxNote);
          attachmentInfo += `\n**NOTE: Vehicle history report (${imageAttachments.length} images) received and saved.**\n`;
        }

        // Process links in email
        const links = extractLinksFromEmail(email);
        const relevantLinks = filterRelevantLinks(links);
        let linkInfo = '';
        if (relevantLinks.length > 0) {
          console.log(`🔗 Found ${relevantLinks.length} links in email`);
          linkInfo = '\n## Links in this email\n';
          for (const link of relevantLinks) {
            linkInfo += `- [${link.type}] ${link.url.slice(0, 60)}${link.url.length > 60 ? '...' : ''}\n`;
          }

          // Process links to extract additional info
          try {
            const linkResults = await processEmailLinks(email, matchedListing);
            if (linkResults.linksProcessed > 0) {
              console.log(`   Processed ${linkResults.linksProcessed} links`);

              // Update listing with any enriched data (like VIN)
              if (Object.keys(linkResults.enrichedData).length > 0) {
                db.updateListing(matchedListing.id, linkResults.enrichedData);
                linkInfo += '\n**Extracted from links:**\n';
                for (const [key, value] of Object.entries(linkResults.enrichedData)) {
                  linkInfo += `- ${key}: ${value}\n`;
                }
              }

              // Note CARFAX URL if found
              if (linkResults.carfaxUrl && !matchedListing.carfaxReceived) {
                linkInfo += `\n**CARFAX link found:** ${linkResults.carfaxUrl}\n`;
              }
            }
          } catch (linkError) {
            console.log(`   ⚠️ Link processing error: ${linkError}`);
          }
        }
        attachmentInfo += linkInfo;

        // Save to conversation history in database
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

        // Invoke Claude for analysis
        console.log('🧠 Analyzing with Claude...');

        try {
          const analysis = await analyzeWithClaude(
            matchedListing,
            email,
            crossListingContext,
            listingDir,
            attachmentInfo,
            carfaxJustReceived,
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

            // Save to conversation history in database
            const outboundMessage: ConversationMessage = {
              date: new Date().toISOString(),
              direction: 'outbound',
              channel: 'email',
              subject: `Re: ${email.subject}`,
              body: analysis.response,
            };
            const currentConversation = db.getListing(matchedListing.id)?.sellerConversation || [];
            db.updateListing(matchedListing.id, {
              sellerConversation: [...currentConversation, outboundMessage],
              lastOurResponseAt: new Date().toISOString(),
            });

            // Log audit entry
            db.logAudit({
              listingId: matchedListing.id,
              action: 'email_sent',
              description: `Auto-response sent: ${analysis.action}`,
              reasoning: analysis.reasoning,
              triggeredBy: 'claude',
            });

            responded++;
          }

        } catch (claudeError) {
          console.log(`❌ Claude analysis failed: ${claudeError}`);
          console.log('   Email saved to workspace for manual review');
        }

        // Mark email as processed to prevent reprocessing
        if (email.messageId) {
          db.markEmailProcessed({
            messageId: email.messageId,
            listingId: matchedListing.id,
            fromAddress: email.from,
            subject: email.subject,
            action: 'processed',
          });
        }

        processed++;
      }

      emailClient.close();

      console.log('\n' + '═'.repeat(70));
      console.log('Smart Respond Summary:');
      console.log(`  Processed: ${processed}`);
      console.log(`  Responded: ${responded}`);
      console.log(`  Duplicates: ${duplicates}`);
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
