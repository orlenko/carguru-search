/**
 * Audit command - view audit trail for a listing
 */
import { Command } from 'commander';
import { getDatabase } from '../../database/index.js';

export const auditCommand = new Command('audit')
  .description('View audit trail for a listing')
  .argument('<id>', 'Listing ID to view audit history for')
  .option('-l, --limit <number>', 'Maximum entries to show', '50')
  .option('--action <type>', 'Filter by action type (state_change, email_sent, etc.)')
  .action(async (id, options) => {
    const db = getDatabase();
    const listingId = parseInt(id, 10);

    if (isNaN(listingId)) {
      console.error('Error: Invalid listing ID');
      process.exit(1);
    }

    // Get listing details
    const listing = db.getListing(listingId);
    if (!listing) {
      console.error(`Error: Listing #${listingId} not found`);
      process.exit(1);
    }

    console.log(`\n📋 Audit Trail for Listing #${listingId}`);
    console.log(`   ${listing.year} ${listing.make} ${listing.model}`);
    console.log(`   Current Status: ${listing.status}`);
    console.log('─'.repeat(60));

    // Get audit log
    const auditLog = db.getAuditLog(listingId);

    if (auditLog.length === 0) {
      console.log('\nNo audit entries found.\n');
      return;
    }

    // Filter by action if specified
    let filteredLog = auditLog;
    if (options.action) {
      filteredLog = auditLog.filter(entry => entry.action === options.action);
    }

    // Limit results
    const limit = parseInt(options.limit, 10);
    filteredLog = filteredLog.slice(0, limit);

    console.log(`\nShowing ${filteredLog.length} of ${auditLog.length} entries:\n`);

    for (const entry of filteredLog) {
      const date = new Date(entry.createdAt);
      const formattedDate = date.toLocaleString('en-CA', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });

      console.log(`[${formattedDate}] ${entry.action.toUpperCase()}`);

      if (entry.fromState && entry.toState) {
        console.log(`  ${entry.fromState} → ${entry.toState}`);
      }

      if (entry.description) {
        console.log(`  ${entry.description}`);
      }

      if (entry.reasoning) {
        console.log(`  Reason: ${entry.reasoning}`);
      }

      console.log(`  Triggered by: ${entry.triggeredBy}`);
      console.log('');
    }

    // Show summary
    const actionCounts: Record<string, number> = {};
    for (const entry of auditLog) {
      actionCounts[entry.action] = (actionCounts[entry.action] || 0) + 1;
    }

    console.log('─'.repeat(60));
    console.log('Action Summary:');
    for (const [action, count] of Object.entries(actionCounts)) {
      console.log(`  ${action}: ${count}`);
    }
    console.log('');
  });
