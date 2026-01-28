/**
 * Portfolio Dashboard - Overview of all active negotiations
 */
import { Command } from 'commander';
import { getDatabase } from '../../database/index.js';
import { loadConfig } from '../../config.js';
import { existsSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';

interface DashboardListing {
  id: number;
  vehicle: string;
  price: number;
  status: string;
  readinessScore: number;
  daysSinceActivity: number;
  totalCost: number | null;
  withinBudget: boolean | null;
  hasCarfax: boolean;
  sellerResponded: boolean;
  nextAction: string;
}

function getNextAction(listing: DashboardListing): string {
  if (listing.status === 'discovered') {
    return 'Run analysis';
  }
  if (listing.status === 'analyzed') {
    return 'Contact seller';
  }
  if (listing.status === 'contacted' || listing.status === 'awaiting_response') {
    if (listing.daysSinceActivity > 2) {
      return 'Send follow-up';
    }
    return 'Waiting for response';
  }
  if (listing.status === 'negotiating') {
    if (!listing.hasCarfax) {
      return 'Request CARFAX';
    }
    if (listing.readinessScore >= 80) {
      return 'Schedule viewing';
    }
    return 'Continue negotiation';
  }
  if (listing.status === 'viewing_scheduled') {
    return 'Attend viewing';
  }
  if (listing.status === 'inspected') {
    return 'Make offer';
  }
  if (listing.status === 'offer_made') {
    return 'Awaiting response';
  }
  return '-';
}

function formatDays(days: number): string {
  if (days === 0) return 'today';
  if (days === 1) return '1 day';
  return `${days} days`;
}

function statusEmoji(status: string): string {
  const emojis: Record<string, string> = {
    'discovered': '🔍',
    'analyzed': '📊',
    'contacted': '📤',
    'awaiting_response': '⏳',
    'negotiating': '💬',
    'viewing_scheduled': '📅',
    'inspected': '👀',
    'offer_made': '💰',
    'purchased': '✅',
    'rejected': '❌',
    'withdrawn': '🚫',
  };
  return emojis[status] || '❓';
}

export const dashboardCommand = new Command('dashboard')
  .description('Show portfolio overview of all active negotiations')
  .option('--all', 'Include completed/rejected listings')
  .option('--export', 'Export dashboard to workspace/portfolio.md')
  .action(async (options) => {
    const db = getDatabase();
    const config = loadConfig();

    // Get all listings in active states
    const activeStates = [
      'discovered', 'analyzed', 'contacted', 'awaiting_response',
      'negotiating', 'viewing_scheduled', 'inspected', 'offer_made'
    ];

    const allStates = options.all
      ? [...activeStates, 'purchased', 'rejected', 'withdrawn']
      : activeStates;

    const listings = db.listListings({ status: allStates as any, limit: 100 });

    // Build dashboard data
    const dashboardData: DashboardListing[] = [];
    let totalExposure = 0;
    const budget = config.search.priceMax || 20000;

    for (const listing of listings) {
      const vehicle = `${listing.year} ${listing.make} ${listing.model}`;
      const cost = db.getCostBreakdown(listing.id);
      const readinessScore = db.calculateReadinessScore(listing.id);

      // Calculate days since last activity
      const lastActivity = listing.lastSellerResponseAt || listing.lastOurResponseAt
        || listing.lastContactedAt || listing.contactedAt || listing.discoveredAt;
      const daysSinceActivity = lastActivity
        ? Math.floor((Date.now() - new Date(lastActivity).getTime()) / (1000 * 60 * 60 * 24))
        : 999;

      const totalCost = cost?.totalEstimatedCost || listing.price;

      const dashboardListing: DashboardListing = {
        id: listing.id,
        vehicle,
        price: listing.price || 0,
        status: listing.status,
        readinessScore,
        daysSinceActivity,
        totalCost,
        withinBudget: cost?.withinBudget ?? (totalCost ? totalCost <= budget : null),
        hasCarfax: listing.carfaxReceived || false,
        sellerResponded: !!listing.firstResponseAt,
        nextAction: '',
      };

      dashboardListing.nextAction = getNextAction(dashboardListing);
      dashboardData.push(dashboardListing);

      // Add to total exposure if in active negotiation
      if (['negotiating', 'viewing_scheduled', 'inspected', 'offer_made'].includes(listing.status)) {
        totalExposure += totalCost || listing.price || 0;
      }
    }

    // Sort by readiness score (highest first), then by status
    dashboardData.sort((a, b) => {
      const statusPriority: Record<string, number> = {
        'offer_made': 1,
        'inspected': 2,
        'viewing_scheduled': 3,
        'negotiating': 4,
        'awaiting_response': 5,
        'contacted': 6,
        'analyzed': 7,
        'discovered': 8,
        'purchased': 9,
        'rejected': 10,
        'withdrawn': 10,
      };
      const statusDiff = (statusPriority[a.status] || 99) - (statusPriority[b.status] || 99);
      if (statusDiff !== 0) return statusDiff;
      return b.readinessScore - a.readinessScore;
    });

    // Print dashboard
    console.log('\n📊 Portfolio Dashboard');
    console.log('═'.repeat(80));

    // Summary stats
    const stats = {
      total: dashboardData.length,
      negotiating: dashboardData.filter(l => ['negotiating', 'awaiting_response'].includes(l.status)).length,
      viewingScheduled: dashboardData.filter(l => l.status === 'viewing_scheduled').length,
      offerMade: dashboardData.filter(l => l.status === 'offer_made').length,
      needsFollowUp: dashboardData.filter(l =>
        ['contacted', 'awaiting_response'].includes(l.status) && l.daysSinceActivity > 2
      ).length,
      highReadiness: dashboardData.filter(l => l.readinessScore >= 80).length,
    };

    console.log(`\n  Active Listings: ${stats.total}`);
    console.log(`  In Negotiation: ${stats.negotiating} | Viewing Scheduled: ${stats.viewingScheduled} | Offer Made: ${stats.offerMade}`);
    console.log(`  Needs Follow-up: ${stats.needsFollowUp} | High Readiness (80+): ${stats.highReadiness}`);
    console.log(`\n  Total Exposure: $${totalExposure.toLocaleString()} | Budget: $${budget.toLocaleString()}`);

    if (totalExposure > budget) {
      console.log(`  ⚠️  OVER BUDGET by $${(totalExposure - budget).toLocaleString()}`);
    } else {
      console.log(`  Remaining: $${(budget - totalExposure).toLocaleString()}`);
    }

    console.log('\n' + '─'.repeat(80));

    // Table header
    console.log(`${'ID'.padEnd(4)} ${'Vehicle'.padEnd(28)} ${'Price'.padEnd(10)} ${'Status'.padEnd(18)} ${'Ready'.padEnd(6)} ${'Activity'.padEnd(10)} Next Action`);
    console.log('─'.repeat(80));

    // Table rows
    for (const listing of dashboardData) {
      const emoji = statusEmoji(listing.status);
      const price = listing.price ? `$${listing.price.toLocaleString()}` : '-';
      const ready = `${listing.readinessScore}%`;
      const activity = formatDays(listing.daysSinceActivity);
      const budgetIndicator = listing.withinBudget === false ? '⚠️' : '';

      console.log(
        `${String(listing.id).padEnd(4)} ` +
        `${listing.vehicle.slice(0, 27).padEnd(28)} ` +
        `${(price + budgetIndicator).padEnd(10)} ` +
        `${(emoji + ' ' + listing.status).padEnd(18)} ` +
        `${ready.padEnd(6)} ` +
        `${activity.padEnd(10)} ` +
        `${listing.nextAction}`
      );
    }

    console.log('─'.repeat(80));

    // Top recommendations
    const topPicks = dashboardData
      .filter(l => !['purchased', 'rejected', 'withdrawn'].includes(l.status))
      .slice(0, 3);

    if (topPicks.length > 0) {
      console.log('\n🎯 Top Priorities:');
      for (let i = 0; i < topPicks.length; i++) {
        const pick = topPicks[i];
        console.log(`  ${i + 1}. #${pick.id} ${pick.vehicle} - ${pick.nextAction}`);
      }
    }

    // Pending approvals
    const pendingApprovals = db.getPendingApprovals();
    if (pendingApprovals.length > 0) {
      console.log(`\n⏸️  Pending Approvals: ${pendingApprovals.length}`);
      console.log('  Run "carsearch approvals" to review');
    }

    console.log('');

    // Export to workspace if requested
    if (options.export) {
      const workspacePath = path.resolve('./workspace');
      if (!existsSync(workspacePath)) {
        mkdirSync(workspacePath, { recursive: true });
      }

      const exportContent = generatePortfolioMarkdown(dashboardData, stats, totalExposure, budget, pendingApprovals);
      const exportPath = path.join(workspacePath, 'portfolio.md');
      writeFileSync(exportPath, exportContent);
      console.log(`📁 Exported to ${exportPath}\n`);
    }
  });

function generatePortfolioMarkdown(
  listings: DashboardListing[],
  stats: Record<string, number>,
  totalExposure: number,
  budget: number,
  pendingApprovals: Array<{ id: number; actionType: string; description: string }>
): string {
  const now = new Date().toISOString().split('T')[0];

  let md = `# Portfolio Dashboard - ${now}\n\n`;

  md += `## Summary\n\n`;
  md += `- **Active Listings:** ${stats.total}\n`;
  md += `- **In Negotiation:** ${stats.negotiating}\n`;
  md += `- **Viewing Scheduled:** ${stats.viewingScheduled}\n`;
  md += `- **Offer Made:** ${stats.offerMade}\n`;
  md += `- **Needs Follow-up:** ${stats.needsFollowUp}\n`;
  md += `- **High Readiness (80+):** ${stats.highReadiness}\n\n`;

  md += `### Budget\n\n`;
  md += `- **Total Exposure:** $${totalExposure.toLocaleString()}\n`;
  md += `- **Budget:** $${budget.toLocaleString()}\n`;
  md += `- **Remaining:** $${(budget - totalExposure).toLocaleString()}\n`;
  if (totalExposure > budget) {
    md += `- **OVER BUDGET by $${(totalExposure - budget).toLocaleString()}**\n`;
  }
  md += `\n`;

  md += `## Active Negotiations\n\n`;
  md += `| ID | Vehicle | Price | Status | Readiness | Last Activity | Next Action |\n`;
  md += `|----|---------|-------|--------|-----------|---------------|-------------|\n`;

  for (const listing of listings) {
    const price = listing.price ? `$${listing.price.toLocaleString()}` : '-';
    const budgetIndicator = listing.withinBudget === false ? ' ⚠️' : '';
    md += `| ${listing.id} | ${listing.vehicle} | ${price}${budgetIndicator} | ${listing.status} | ${listing.readinessScore}% | ${formatDays(listing.daysSinceActivity)} | ${listing.nextAction} |\n`;
  }

  md += `\n`;

  if (pendingApprovals.length > 0) {
    md += `## Pending Approvals\n\n`;
    for (const approval of pendingApprovals) {
      md += `- **[#${approval.id}] ${approval.actionType}:** ${approval.description}\n`;
    }
    md += `\n`;
  }

  const topPicks = listings
    .filter(l => !['purchased', 'rejected', 'withdrawn'].includes(l.status))
    .slice(0, 5);

  if (topPicks.length > 0) {
    md += `## Top Priorities\n\n`;
    for (let i = 0; i < topPicks.length; i++) {
      const pick = topPicks[i];
      md += `${i + 1}. **#${pick.id} ${pick.vehicle}** - ${pick.nextAction}\n`;
      md += `   - Price: $${pick.price.toLocaleString()} | Readiness: ${pick.readinessScore}%\n`;
    }
    md += `\n`;
  }

  md += `---\n\n`;
  md += `*Generated by carsearch dashboard --export*\n`;

  return md;
}
