import { Command } from 'commander';
import { getDatabase } from '../../database/index.js';
import * as fs from 'fs';
import * as path from 'path';
import { runClaudeTask } from '../../claude/task-runner.js';
import {
  syncListingToWorkspace,
  writeSearchContext,
  WORKSPACE_DIR,
  getListingWorkspaceDir,
} from '../../workspace/index.js';

const CLAUDE_SENTINEL = 'task complete';

export const syncWorkspaceCommand = new Command('sync-workspace')
  .description('Sync contacted listings to workspace for Claude analysis')
  .option('--id <id>', 'Sync specific listing ID')
  .option('--all', 'Sync all contacted listings')
  .action(async (options) => {
    try {
      const db = getDatabase();

      // Ensure workspace exists + search context
      writeSearchContext();

      let listings: { id: number }[] = [];

      if (options.id) {
        listings = [{ id: parseInt(options.id) }];
      } else if (options.all) {
        listings = db.listListings({
          status: ['contacted', 'awaiting_response', 'negotiating'] as any,
          limit: 100,
        });
      } else {
        // Default: sync contacted listings
        listings = db.listListings({
          status: ['contacted', 'awaiting_response', 'negotiating'] as any,
          limit: 100,
        });
      }

      if (listings.length === 0) {
        console.log('No listings to sync.');
        return;
      }

      console.log(`\nSyncing ${listings.length} listing(s) to workspace...\n`);

      for (const { id } of listings) {
        const listing = db.getListing(id);
        if (!listing) continue;

        const dir = syncListingToWorkspace(listing);
        console.log(`✅ #${id}: ${listing.year} ${listing.make} ${listing.model} → ${dir}`);
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

      const listingDir = getListingWorkspaceDir(listing);
      const emailsDir = path.join(listingDir, 'emails');

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

      writeSearchContext();
      const listingDir = getListingWorkspaceDir(listing);

      // Sync listing if not already in workspace
      if (!fs.existsSync(listingDir)) {
        console.log('Syncing listing to workspace...');
        syncListingToWorkspace(listing);
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

      const taskDir = path.join(listingDir, 'claude', `ask-claude-${Date.now()}`);
      fs.mkdirSync(taskDir, { recursive: true });
      const taskFile = path.join(taskDir, 'task.md');
      const resultFile = path.join(taskDir, 'result.md');
      const resultRel = path.relative(listingDir, resultFile);

      const taskBody = `${prompt}

---

Write your response in markdown to: ${resultRel}

After writing the file, output this line exactly:
${CLAUDE_SENTINEL}
`;
      fs.writeFileSync(taskFile, taskBody);

      await runClaudeTask({
        workspaceDir: listingDir,
        taskFile: path.relative(listingDir, taskFile),
        resultFile: resultRel,
        model: process.env.CLAUDE_MODEL || undefined,
        dangerous: process.env.CLAUDE_DANGEROUS !== 'false',
        timeoutMs: 120000,
        sentinel: CLAUDE_SENTINEL,
      });

      if (!fs.existsSync(resultFile)) {
        console.error('Claude did not write a result file.');
        process.exit(1);
      }

      const output = fs.readFileSync(resultFile, 'utf-8');
      console.log(output.trim());

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

      writeSearchContext();
      const listingDir = syncListingToWorkspace(listing);
      const taskDir = path.join(listingDir, 'claude', `analyze-email-${Date.now()}`);
      fs.mkdirSync(taskDir, { recursive: true });
      const taskFile = path.join(taskDir, 'task.md');
      const resultFile = path.join(taskDir, 'result.json');
      const resultRel = path.relative(listingDir, resultFile);

      const taskBody = `${prompt}

---

Write ONLY the JSON to: ${resultRel}

After writing the file, output this line exactly:
${CLAUDE_SENTINEL}
`;
      fs.writeFileSync(taskFile, taskBody);

      await runClaudeTask({
        workspaceDir: listingDir,
        taskFile: path.relative(listingDir, taskFile),
        resultFile: resultRel,
        model: process.env.CLAUDE_MODEL || undefined,
        dangerous: process.env.CLAUDE_DANGEROUS !== 'false',
        timeoutMs: 120000,
        sentinel: CLAUDE_SENTINEL,
      });

      if (!fs.existsSync(resultFile)) {
        console.error('Claude did not write a result file.');
        process.exit(1);
      }

      const output = fs.readFileSync(resultFile, 'utf-8');
      const jsonMatch = output.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.log('Raw output:', output);
        return;
      }

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

    } catch (error) {
      console.error('Failed:', error);
      process.exit(1);
    }
  });
