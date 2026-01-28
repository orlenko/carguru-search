/**
 * Rank Offers Command (Flow 3)
 * Uses Claude to identify the top listings based on negotiations and gathered data
 */

import { Command } from 'commander';
import { getDatabase } from '../../database/index.js';
import { loadConfig } from '../../config.js';
import { spawn } from 'child_process';
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

interface RankedListing {
  id: number;
  rank: number;
  vehicle: string;
  score: number;
  totalCost: number;
  withinBudget: boolean;
  carfaxStatus: string;
  negotiationStatus: string;
  sellerResponsiveness: string;
  redFlagCount: number;
  recommendation: string;
  nextAction: string;
}

/**
 * Calculate seller responsiveness based on conversation history
 */
function calculateResponsiveness(listing: ReturnType<typeof getDatabase>['getListing'] extends (id: number) => infer R ? NonNullable<R> : never): string {
  const conversation = listing.sellerConversation || [];
  const inboundCount = conversation.filter(m => m.direction === 'inbound').length;
  const outboundCount = conversation.filter(m => m.direction === 'outbound').length;

  if (outboundCount === 0) return 'Not contacted';
  if (inboundCount === 0) return 'No response yet';

  const responseRate = inboundCount / outboundCount;
  if (responseRate >= 1) return 'Very responsive';
  if (responseRate >= 0.5) return 'Responsive';
  return 'Slow to respond';
}

/**
 * Get negotiation status summary
 */
function getNegotiationStatus(listing: ReturnType<typeof getDatabase>['getListing'] extends (id: number) => infer R ? NonNullable<R> : never): string {
  if (listing.negotiatedPrice) {
    const savings = (listing.price || 0) - listing.negotiatedPrice;
    return `Negotiated to $${listing.negotiatedPrice.toLocaleString()} (saved $${savings.toLocaleString()})`;
  }

  const status = listing.status;
  switch (status) {
    case 'discovered': return 'Not started';
    case 'analyzed': return 'Analyzed, not contacted';
    case 'contacted': return 'Initial contact sent';
    case 'awaiting_response': return 'Waiting for seller';
    case 'negotiating': return 'Active negotiation';
    case 'viewing_scheduled': return 'Viewing scheduled';
    case 'inspected': return 'Inspected, making decision';
    case 'offer_made': return 'Offer submitted';
    default: return status;
  }
}

export const rankOffersCommand = new Command('rank-offers')
  .description('Flow 3: Rank top listings based on negotiations and gathered data')
  .option('--top <n>', 'Number of top listings to show', '5')
  .option('--budget <amount>', 'Override budget for ranking')
  .option('--json', 'Output as JSON')
  .option('--interactive', 'Launch interactive Claude session for deep analysis')
  .option('--export', 'Export ranking to workspace')
  .action(async (options) => {
    const db = getDatabase();
    const config = loadConfig();
    const budget = options.budget ? parseInt(options.budget) : (config.search.priceMax || 18000);
    const topN = parseInt(options.top);

    console.log('\n🏆 Ranking Top Offers\n');
    console.log('─'.repeat(70));

    // Get all active listings (not rejected/withdrawn/purchased)
    const activeStatuses = ['analyzed', 'contacted', 'awaiting_response', 'negotiating', 'viewing_scheduled', 'inspected', 'offer_made'];
    const listings = db.listListings({ status: activeStatuses as any, limit: 100 });

    if (listings.length === 0) {
      console.log('No active listings to rank.');
      return;
    }

    console.log(`Analyzing ${listings.length} active listings...\n`);

    // Gather comprehensive data for each listing
    const listingData: Array<{
      listing: typeof listings[0];
      cost: ReturnType<typeof db.getCostBreakdown>;
      readiness: number;
      responsiveness: string;
      negotiationStatus: string;
      redFlags: string[];
      positives: string[];
    }> = [];

    for (const listing of listings) {
      const cost = db.getCostBreakdown(listing.id);
      const readiness = db.calculateReadinessScore(listing.id);
      const responsiveness = calculateResponsiveness(listing);
      const negotiationStatus = getNegotiationStatus(listing);

      let redFlags: string[] = [];
      let positives: string[] = [];

      if (listing.aiAnalysis) {
        try {
          const analysis = JSON.parse(listing.aiAnalysis);
          redFlags = analysis.redFlags || analysis.concerns || [];
          positives = analysis.positives || [];
        } catch {}
      }

      listingData.push({
        listing,
        cost,
        readiness,
        responsiveness,
        negotiationStatus,
        redFlags,
        positives,
      });
    }

    // Sort by readiness score and then by cost
    listingData.sort((a, b) => {
      // First by readiness
      if (b.readiness !== a.readiness) {
        return b.readiness - a.readiness;
      }
      // Then by total cost (lower is better)
      const aCost = a.cost?.totalEstimatedCost || a.listing.price || Infinity;
      const bCost = b.cost?.totalEstimatedCost || b.listing.price || Infinity;
      return aCost - bCost;
    });

    // Take top N
    const topListings = listingData.slice(0, topN);

    // Display results
    console.log(`${'Rank'.padEnd(5)} ${'ID'.padEnd(4)} ${'Vehicle'.padEnd(26)} ${'Total Cost'.padEnd(12)} ${'Ready'.padEnd(6)} Status`);
    console.log('─'.repeat(70));

    for (let i = 0; i < topListings.length; i++) {
      const { listing, cost, readiness, negotiationStatus } = topListings[i];
      const vehicle = `${listing.year} ${listing.make} ${listing.model}`.slice(0, 25);
      const totalCost = cost?.totalEstimatedCost
        ? `$${cost.totalEstimatedCost.toLocaleString()}`
        : `$${(listing.price || 0).toLocaleString()}*`;
      const withinBudget = cost?.withinBudget ?? (listing.price || 0) <= budget;
      const budgetIcon = withinBudget ? '✅' : '⚠️';

      console.log(
        `#${i + 1}`.padEnd(5) +
        `${listing.id}`.padEnd(4) +
        `${vehicle}`.padEnd(26) +
        `${totalCost}`.padEnd(12) +
        `${readiness}%`.padEnd(6) +
        `${budgetIcon} ${negotiationStatus}`
      );
    }

    console.log('─'.repeat(70));
    console.log(`Budget: $${budget.toLocaleString()}`);
    console.log(`* = estimated cost (not yet calculated)\n`);

    // Show detailed breakdown for top 3
    console.log('\n📊 Top 3 Detailed Analysis\n');

    for (let i = 0; i < Math.min(3, topListings.length); i++) {
      const { listing, cost, readiness, responsiveness, negotiationStatus, redFlags, positives } = topListings[i];
      const vehicle = `${listing.year} ${listing.make} ${listing.model}`;

      console.log('═'.repeat(70));
      console.log(`#${i + 1}: ${vehicle} (Listing #${listing.id})`);
      console.log('═'.repeat(70));

      console.log('\n💰 Pricing:');
      console.log(`   Listed Price:    $${(listing.price || 0).toLocaleString()}`);
      if (listing.negotiatedPrice) {
        console.log(`   Negotiated:      $${listing.negotiatedPrice.toLocaleString()}`);
      }
      if (cost) {
        console.log(`   Total Cost:      $${cost.totalEstimatedCost?.toLocaleString() || 'N/A'}`);
        console.log(`   Within Budget:   ${cost.withinBudget ? '✅ Yes' : '❌ No'} (${cost.remainingBudget ? `$${cost.remainingBudget.toLocaleString()} remaining` : 'over budget'})`);
      }

      console.log('\n📄 CARFAX:');
      if (listing.carfaxReceived) {
        console.log(`   Status:          ✅ Received`);
        console.log(`   Accidents:       ${listing.accidentCount ?? 'Unknown'}`);
        console.log(`   Owners:          ${listing.ownerCount ?? 'Unknown'}`);
        console.log(`   Service Records: ${listing.serviceRecordCount ?? 'Unknown'}`);
      } else {
        console.log(`   Status:          ❌ Not received`);
      }

      console.log('\n📞 Seller:');
      console.log(`   Name:            ${listing.sellerName || 'Unknown'}`);
      console.log(`   Type:            ${listing.sellerType || 'Unknown'}`);
      console.log(`   Responsiveness:  ${responsiveness}`);
      console.log(`   Messages:        ${listing.sellerConversation?.length || 0}`);

      console.log('\n📈 Status:');
      console.log(`   Negotiation:     ${negotiationStatus}`);
      console.log(`   Readiness Score: ${readiness}/100`);

      if (positives.length > 0) {
        console.log('\n✅ Positives:');
        for (const p of positives.slice(0, 3)) {
          console.log(`   + ${p}`);
        }
      }

      if (redFlags.length > 0) {
        console.log('\n⚠️ Concerns:');
        for (const r of redFlags.slice(0, 3)) {
          console.log(`   - ${r}`);
        }
      }

      // Recommended action based on status
      console.log('\n🎯 Recommended Action:');
      if (!listing.carfaxReceived) {
        console.log('   → Request CARFAX before proceeding');
      } else if (listing.status === 'analyzed' || listing.status === 'discovered') {
        console.log('   → Send initial inquiry');
      } else if (listing.status === 'contacted' || listing.status === 'awaiting_response') {
        console.log('   → Follow up with seller');
      } else if (listing.status === 'negotiating') {
        if (cost?.withinBudget) {
          console.log('   → Make an offer or schedule viewing');
        } else {
          console.log('   → Continue negotiating price down');
        }
      } else if (listing.status === 'viewing_scheduled') {
        console.log('   → Prepare inspection checklist');
      } else if (listing.status === 'inspected') {
        console.log('   → Make final offer based on inspection');
      }

      console.log('');
    }

    // Interactive mode - launch Claude for deeper analysis
    if (options.interactive) {
      console.log('\n🤖 Launching Claude for detailed analysis...\n');

      const prompt = buildClaudePrompt(topListings.slice(0, 5), budget);

      // Write prompt to temp file
      const promptFile = join(tmpdir(), `rank-offers-${Date.now()}.txt`);
      writeFileSync(promptFile, prompt);

      // Launch interactive Claude session
      const claude = spawn('claude', ['-p', `$(cat "${promptFile}")`], {
        cwd: process.cwd(),
        stdio: 'inherit',
        shell: true,
      });

      claude.on('exit', () => {
        try { unlinkSync(promptFile); } catch {}
      });

      return;
    }

    // Export to workspace
    if (options.export) {
      const exportDir = 'workspace/rankings';
      mkdirSync(exportDir, { recursive: true });

      const timestamp = new Date().toISOString().split('T')[0];
      const exportPath = join(exportDir, `ranking-${timestamp}.md`);

      let exportContent = `# Top Offers Ranking - ${timestamp}\n\n`;
      exportContent += `**Budget:** $${budget.toLocaleString()}\n\n`;
      exportContent += `## Rankings\n\n`;

      for (let i = 0; i < topListings.length; i++) {
        const { listing, cost, readiness, responsiveness, negotiationStatus, redFlags, positives } = topListings[i];
        const vehicle = `${listing.year} ${listing.make} ${listing.model}`;

        exportContent += `### #${i + 1}: ${vehicle} (ID: ${listing.id})\n\n`;
        exportContent += `- **Price:** $${(listing.price || 0).toLocaleString()}`;
        if (cost?.totalEstimatedCost) {
          exportContent += ` → Total: $${cost.totalEstimatedCost.toLocaleString()}`;
        }
        exportContent += '\n';
        exportContent += `- **Readiness:** ${readiness}%\n`;
        exportContent += `- **CARFAX:** ${listing.carfaxReceived ? '✅ Received' : '❌ Pending'}\n`;
        exportContent += `- **Responsiveness:** ${responsiveness}\n`;
        exportContent += `- **Status:** ${negotiationStatus}\n`;

        if (positives.length > 0) {
          exportContent += `\n**Positives:**\n`;
          for (const p of positives) {
            exportContent += `- ${p}\n`;
          }
        }

        if (redFlags.length > 0) {
          exportContent += `\n**Concerns:**\n`;
          for (const r of redFlags) {
            exportContent += `- ${r}\n`;
          }
        }

        exportContent += '\n---\n\n';
      }

      writeFileSync(exportPath, exportContent);
      console.log(`📁 Exported to ${exportPath}`);
    }

    // JSON output
    if (options.json) {
      const jsonOutput = topListings.map((data, i) => ({
        rank: i + 1,
        id: data.listing.id,
        vehicle: `${data.listing.year} ${data.listing.make} ${data.listing.model}`,
        price: data.listing.price,
        totalCost: data.cost?.totalEstimatedCost,
        withinBudget: data.cost?.withinBudget ?? (data.listing.price || 0) <= budget,
        readinessScore: data.readiness,
        carfaxReceived: data.listing.carfaxReceived,
        accidentCount: data.listing.accidentCount,
        responsiveness: data.responsiveness,
        negotiationStatus: data.negotiationStatus,
        redFlagCount: data.redFlags.length,
        positives: data.positives,
        redFlags: data.redFlags,
      }));

      console.log('\nJSON Output:');
      console.log(JSON.stringify(jsonOutput, null, 2));
    }

    // Show next steps
    console.log('\n📋 Next Steps:');
    console.log('   1. Run `npm run dev -- rank-offers --interactive` for Claude analysis');
    console.log('   2. Run `npm run dev -- show <id>` for detailed listing view');
    console.log('   3. Run `npm run dev -- negotiate <id> --start` to begin negotiation');
    console.log('');
  });

/**
 * Build prompt for Claude analysis
 */
function buildClaudePrompt(
  listings: Array<{
    listing: any;
    cost: any;
    readiness: number;
    responsiveness: string;
    negotiationStatus: string;
    redFlags: string[];
    positives: string[];
  }>,
  budget: number
): string {
  let prompt = `You are a car buying advisor helping a buyer choose the best vehicle from their shortlist.

## Budget
Maximum: $${budget.toLocaleString()} (total out-the-door cost including taxes and fees)

## Top Candidates

`;

  for (let i = 0; i < listings.length; i++) {
    const { listing, cost, readiness, responsiveness, negotiationStatus, redFlags, positives } = listings[i];
    const vehicle = `${listing.year} ${listing.make} ${listing.model}`;

    prompt += `### Option ${i + 1}: ${vehicle} (ID #${listing.id})

**Pricing:**
- Listed: $${(listing.price || 0).toLocaleString()}
- Total estimated cost: $${cost?.totalEstimatedCost?.toLocaleString() || 'Not calculated'}
- Within budget: ${cost?.withinBudget ? 'Yes' : 'No/Unknown'}
${listing.negotiatedPrice ? `- Negotiated to: $${listing.negotiatedPrice.toLocaleString()}` : ''}

**Vehicle Details:**
- Mileage: ${listing.mileageKm?.toLocaleString() || 'Unknown'} km
- VIN: ${listing.vin || 'Not available'}
- Location: ${listing.city}, ${listing.province} (${listing.distanceKm || '?'} km away)

**CARFAX:**
${listing.carfaxReceived
  ? `- Received ✓
- Accidents: ${listing.accidentCount ?? 'Unknown'}
- Previous owners: ${listing.ownerCount ?? 'Unknown'}
- Service records: ${listing.serviceRecordCount ?? 'Unknown'}`
  : '- Not yet received'}
${listing.carfaxSummary ? `\nSummary: ${listing.carfaxSummary}` : ''}

**Seller:**
- Name: ${listing.sellerName || 'Unknown'} (${listing.sellerType})
- Responsiveness: ${responsiveness}
- Messages exchanged: ${listing.sellerConversation?.length || 0}

**Status:**
- Negotiation: ${negotiationStatus}
- Readiness score: ${readiness}/100

**Positives:**
${positives.length > 0 ? positives.map(p => `- ${p}`).join('\n') : 'None identified'}

**Concerns:**
${redFlags.length > 0 ? redFlags.map(r => `- ${r}`).join('\n') : 'None identified'}

---

`;
  }

  prompt += `## Your Analysis

Please provide:

1. **Ranking** - Rank these options from best to worst, with brief justification for each
2. **Top Pick** - Which car should the buyer focus on and why?
3. **Deal Breakers** - Are there any options that should be eliminated?
4. **Negotiation Strategy** - For the top pick, what price should they aim for?
5. **Immediate Actions** - What should the buyer do right now for each option?

Be specific and practical. Consider:
- Total cost vs. budget
- CARFAX history and accident reports
- Seller responsiveness and trustworthiness
- Red flags that affect value
- Negotiation leverage available
`;

  return prompt;
}

/**
 * Quick ranking command that uses Claude for AI-powered analysis
 */
export const aiRankCommand = new Command('ai-rank')
  .description('Get Claude\'s AI-powered ranking of top offers')
  .option('--budget <amount>', 'Override budget')
  .action(async (options) => {
    const db = getDatabase();
    const config = loadConfig();
    const budget = options.budget ? parseInt(options.budget) : (config.search.priceMax || 18000);

    console.log('\n🤖 AI-Powered Offer Ranking\n');

    // Get active listings
    const activeStatuses = ['analyzed', 'contacted', 'awaiting_response', 'negotiating', 'viewing_scheduled', 'inspected'];
    const listings = db.listListings({ status: activeStatuses as any, limit: 50 });

    if (listings.length === 0) {
      console.log('No active listings to rank.');
      return;
    }

    // Gather data
    const listingData = listings.map(listing => {
      const cost = db.getCostBreakdown(listing.id);
      const readiness = db.calculateReadinessScore(listing.id);
      const responsiveness = calculateResponsiveness(listing);
      const negotiationStatus = getNegotiationStatus(listing);

      let redFlags: string[] = [];
      let positives: string[] = [];

      if (listing.aiAnalysis) {
        try {
          const analysis = JSON.parse(listing.aiAnalysis);
          redFlags = analysis.redFlags || analysis.concerns || [];
          positives = analysis.positives || [];
        } catch {}
      }

      return { listing, cost, readiness, responsiveness, negotiationStatus, redFlags, positives };
    });

    // Sort by readiness
    listingData.sort((a, b) => b.readiness - a.readiness);

    // Build prompt
    const prompt = buildClaudePrompt(listingData.slice(0, 5), budget);

    console.log('Analyzing top candidates with Claude...\n');

    // Write prompt to temp file
    const promptFile = join(tmpdir(), `ai-rank-${Date.now()}.txt`);
    writeFileSync(promptFile, prompt);

    try {
      // Run Claude with print mode
      const { stdout } = await execAsync(
        `cat "${promptFile}" | claude --print --model sonnet`,
        { timeout: 120000, maxBuffer: 1024 * 1024 }
      );

      console.log(stdout);
    } catch (error) {
      console.error('Claude analysis failed:', error);
    } finally {
      try { unlinkSync(promptFile); } catch {}
    }
  });
