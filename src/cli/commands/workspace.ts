import { Command } from 'commander';
import { getDatabase } from '../../database/index.js';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

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
function syncListingToWorkspace(listingId: number): string | null {
  const db = getDatabase();
  const listing = db.getListing(listingId);

  if (!listing) {
    console.error(`Listing #${listingId} not found`);
    return null;
  }

  const dirName = getListingDirName(listing);
  const listingDir = path.join(LISTINGS_DIR, dirName);
  const emailsDir = path.join(listingDir, 'emails');
  const attachmentsDir = path.join(listingDir, 'attachments');

  // Create directories
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

## Pricing Assessment

${analysis.pricing?.assessment || 'No pricing assessment available.'}

## Recommendation

${analysis.recommendation || 'No recommendation available.'}
`;
      fs.writeFileSync(path.join(listingDir, 'analysis.md'), analysisMd);
    } catch {
      // Invalid JSON, skip analysis
    }
  }

  // Copy CARFAX if exists
  if (listing.carfaxPath && fs.existsSync(listing.carfaxPath)) {
    fs.copyFileSync(listing.carfaxPath, path.join(listingDir, 'carfax.pdf'));
  }

  // Write CARFAX summary if available
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

  // Write conversation history if exists
  if (listing.sellerConversation && listing.sellerConversation.length > 0) {
    let emailNum = 1;

    for (const msg of listing.sellerConversation) {
      const direction = msg.direction || 'inbound';
      const date = msg.date || new Date().toISOString();
      const dateStr = date.split('T')[0];
      const filename = `${String(emailNum).padStart(2, '0')}-${direction}-${dateStr}.md`;

      const emailMd = `# ${direction === 'outbound' ? 'Sent' : 'Received'}: ${date}

**Channel:** ${msg.channel}
**Subject:** ${msg.subject || 'N/A'}

---

${msg.body || 'No content'}
`;
      fs.writeFileSync(path.join(emailsDir, filename), emailMd);
      emailNum++;
    }
  }

  return listingDir;
}

export const syncWorkspaceCommand = new Command('sync-workspace')
  .description('Sync contacted listings to workspace for Claude analysis')
  .option('--id <id>', 'Sync specific listing ID')
  .option('--all', 'Sync all contacted listings')
  .action(async (options) => {
    try {
      const db = getDatabase();

      // Ensure workspace exists
      fs.mkdirSync(LISTINGS_DIR, { recursive: true });

      let listings: { id: number }[] = [];

      if (options.id) {
        listings = [{ id: parseInt(options.id) }];
      } else if (options.all) {
        listings = db.listListings({ status: 'contacted', limit: 100 });
      } else {
        // Default: sync contacted listings
        listings = db.listListings({ status: 'contacted', limit: 100 });
      }

      if (listings.length === 0) {
        console.log('No listings to sync.');
        return;
      }

      console.log(`\nSyncing ${listings.length} listing(s) to workspace...\n`);

      for (const { id } of listings) {
        const listing = db.getListing(id);
        if (!listing) continue;

        const dir = syncListingToWorkspace(id);
        if (dir) {
          console.log(`✅ #${id}: ${listing.year} ${listing.make} ${listing.model} → ${dir}`);
        }
      }

      console.log(`\nWorkspace synced: ${WORKSPACE_DIR}/`);
      console.log('Run `carsearch ask-claude <id> "<email text>"` to analyze a response.');
    } catch (error) {
      console.error('Sync failed:', error);
      process.exit(1);
    }
  });

export const addEmailCommand = new Command('add-email')
  .description('Add an email to a listing\'s workspace folder')
  .argument('<id>', 'Listing ID')
  .argument('<direction>', 'Email direction: inbound or outbound')
  .option('--from <from>', 'From address')
  .option('--subject <subject>', 'Email subject')
  .option('--file <file>', 'Read email body from file')
  .option('--text <text>', 'Email body text')
  .action(async (id, direction, options) => {
    try {
      const db = getDatabase();
      const listing = db.getListing(parseInt(id));

      if (!listing) {
        console.error(`Listing #${id} not found`);
        process.exit(1);
      }

      const dirName = getListingDirName(listing);
      const emailsDir = path.join(LISTINGS_DIR, dirName, 'emails');

      if (!fs.existsSync(emailsDir)) {
        console.error(`Listing not synced to workspace. Run: carsearch sync-workspace --id ${id}`);
        process.exit(1);
      }

      // Find next email number
      const existingEmails = fs.readdirSync(emailsDir).filter(f => f.endsWith('.md'));
      const nextNum = existingEmails.length + 1;

      const dateStr = new Date().toISOString().split('T')[0];
      const filename = `${String(nextNum).padStart(2, '0')}-${direction}-${dateStr}.md`;

      let body = options.text || '';
      if (options.file && fs.existsSync(options.file)) {
        body = fs.readFileSync(options.file, 'utf-8');
      }

      const emailMd = `# ${direction === 'outbound' ? 'Sent' : 'Received'}: ${new Date().toISOString()}

**From:** ${options.from || (direction === 'outbound' ? 'Buyer' : listing.sellerName || 'Seller')}
**Subject:** ${options.subject || 'N/A'}

---

${body}
`;

      fs.writeFileSync(path.join(emailsDir, filename), emailMd);
      console.log(`✅ Added email: ${path.join(emailsDir, filename)}`);
    } catch (error) {
      console.error('Failed to add email:', error);
      process.exit(1);
    }
  });

export const askClaudeCommand = new Command('ask-claude')
  .description('Invoke Claude to analyze a dealer response and suggest reply')
  .argument('<id>', 'Listing ID')
  .argument('[email]', 'The email text to analyze (or use --file)')
  .option('--file <file>', 'Read email from file')
  .option('--save', 'Save the email to workspace before analyzing')
  .option('--from <from>', 'Sender of the email (for --save)')
  .option('--subject <subject>', 'Subject of the email (for --save)')
  .action(async (id, emailText, options) => {
    try {
      const db = getDatabase();
      const listing = db.getListing(parseInt(id));

      if (!listing) {
        console.error(`Listing #${id} not found`);
        process.exit(1);
      }

      const dirName = getListingDirName(listing);
      const listingDir = path.join(LISTINGS_DIR, dirName);

      // Sync listing if not already in workspace
      if (!fs.existsSync(listingDir)) {
        console.log('Syncing listing to workspace...');
        syncListingToWorkspace(parseInt(id));
      }

      // Get email text
      let email = emailText || '';
      if (options.file && fs.existsSync(options.file)) {
        email = fs.readFileSync(options.file, 'utf-8');
      }

      if (!email) {
        console.error('No email text provided. Use argument or --file');
        process.exit(1);
      }

      // Save email if requested
      if (options.save) {
        const emailsDir = path.join(listingDir, 'emails');
        fs.mkdirSync(emailsDir, { recursive: true });

        const existingEmails = fs.readdirSync(emailsDir).filter(f => f.endsWith('.md'));
        const nextNum = existingEmails.length + 1;
        const dateStr = new Date().toISOString().split('T')[0];
        const filename = `${String(nextNum).padStart(2, '0')}-inbound-${dateStr}.md`;

        const emailMd = `# Received: ${new Date().toISOString()}

**From:** ${options.from || listing.sellerName || 'Seller'}
**Subject:** ${options.subject || 'Re: Vehicle Inquiry'}

---

${email}
`;
        fs.writeFileSync(path.join(emailsDir, filename), emailMd);
        console.log(`Saved email to: ${path.join(emailsDir, filename)}`);
      }

      // Build the prompt for Claude
      const vehicle = `${listing.year} ${listing.make} ${listing.model}`;
      const prompt = `Analyze this dealer response for listing #${id} (${vehicle}).

The listing details are in: ${listingDir}/listing.md
Previous correspondence is in: ${listingDir}/emails/
${listing.carfaxPath ? `CARFAX report is at: ${listingDir}/carfax.pdf` : 'No CARFAX received yet.'}

---

**Latest email from dealer:**

${email}

---

Please analyze this email following the instructions in CLAUDE.md:
1. Classify the email intent
2. Extract key information
3. Recommend next action
4. Draft a response if needed`;

      console.log('\n' + '═'.repeat(60));
      console.log('Invoking Claude to analyze dealer response...');
      console.log('═'.repeat(60) + '\n');

      // Invoke Claude CLI
      const claude = spawn('claude', ['-p', prompt], {
        cwd: WORKSPACE_DIR,
        stdio: 'inherit',
      });

      claude.on('error', (err) => {
        console.error('Failed to invoke Claude:', err);
        console.log('\nMake sure Claude CLI is installed: npm install -g @anthropic-ai/claude-code');
        process.exit(1);
      });

      claude.on('exit', (code) => {
        if (code !== 0) {
          console.error(`\nClaude exited with code ${code}`);
        }
      });

    } catch (error) {
      console.error('Failed:', error);
      process.exit(1);
    }
  });

export const analyzeEmailCommand = new Command('analyze-email')
  .description('Use AI to classify and analyze a dealer email (non-interactive)')
  .argument('<id>', 'Listing ID')
  .option('--email <text>', 'Email text to analyze')
  .option('--file <file>', 'Read email from file')
  .action(async (id, options) => {
    try {
      const db = getDatabase();
      const listing = db.getListing(parseInt(id));

      if (!listing) {
        console.error(`Listing #${id} not found`);
        process.exit(1);
      }

      let email = options.email || '';
      if (options.file && fs.existsSync(options.file)) {
        email = fs.readFileSync(options.file, 'utf-8');
      }

      if (!email) {
        console.error('No email text provided');
        process.exit(1);
      }

      const vehicle = `${listing.year} ${listing.make} ${listing.model}`;

      // Use Claude CLI in non-interactive mode to get JSON response
      const prompt = `You are a car buying assistant. Analyze this dealer email and respond with ONLY valid JSON.

Vehicle: ${vehicle}
Price: $${listing.price?.toLocaleString()}
Seller: ${listing.sellerName || 'Unknown'}
CARFAX Received: ${listing.carfaxReceived ? 'Yes' : 'No'}

Email from dealer:
"""
${email}
"""

Respond with this exact JSON structure:
{
  "classification": "available_with_carfax|available_no_carfax|sold|question|counter_offer|info_provided|spam",
  "summary": "One sentence summary of the email",
  "key_points": ["extracted point 1", "extracted point 2"],
  "price_mentioned": null or number,
  "action": "request_carfax|analyze_carfax|negotiate|respond_to_question|mark_sold|ignore",
  "urgency": "high|medium|low",
  "draft_response": "The suggested response text, or null if no response needed"
}`;

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

      claude.on('exit', (code) => {
        if (code !== 0) {
          console.error('Claude analysis failed:', errorOutput);
          process.exit(1);
        }

        // Try to parse JSON from output
        try {
          // Find JSON in output (may have other text around it)
          const jsonMatch = output.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const result = JSON.parse(jsonMatch[0]);

            console.log('\n📧 Email Analysis\n');
            console.log(`Classification: ${result.classification}`);
            console.log(`Summary: ${result.summary}`);
            console.log(`Action: ${result.action}`);
            console.log(`Urgency: ${result.urgency}`);

            if (result.key_points?.length > 0) {
              console.log('\nKey Points:');
              result.key_points.forEach((p: string) => console.log(`  - ${p}`));
            }

            if (result.price_mentioned) {
              console.log(`\nPrice Mentioned: $${result.price_mentioned.toLocaleString()}`);
            }

            if (result.draft_response) {
              console.log('\n--- Suggested Response ---\n');
              console.log(result.draft_response);
              console.log('\n--------------------------');
            }
          } else {
            console.log('Raw output:', output);
          }
        } catch (e) {
          console.log('Could not parse JSON response. Raw output:');
          console.log(output);
        }
      });

    } catch (error) {
      console.error('Failed:', error);
      process.exit(1);
    }
  });
