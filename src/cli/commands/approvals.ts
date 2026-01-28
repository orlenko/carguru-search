/**
 * Approvals command - manage human approval checkpoints
 */
import { Command } from 'commander';
import { getDatabase } from '../../database/index.js';
import { getCheckpointsConfig } from '../../config.js';
import * as readline from 'readline';

function createReadlineInterface(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

async function promptUser(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim().toLowerCase());
    });
  });
}

/**
 * List pending approvals
 */
export const approvalsListCommand = new Command('approvals')
  .description('List pending actions requiring human approval')
  .option('-l, --limit <number>', 'Maximum entries to show', '50')
  .option('--listing <id>', 'Filter by listing ID')
  .option('--type <type>', 'Filter by action type')
  .action(async (options) => {
    const db = getDatabase();
    const config = getCheckpointsConfig();

    if (!config.enabled) {
      console.log('\nCheckpoints are disabled in config.\n');
      return;
    }

    const stats = db.getApprovalStats();

    console.log('\n📋 Approval Queue');
    console.log('─'.repeat(60));
    console.log(`Pending: ${stats.pending} | Approved: ${stats.approved} | Rejected: ${stats.rejected} | Expired: ${stats.expired}`);
    console.log('─'.repeat(60));

    const pending = db.getPendingApprovals({
      listingId: options.listing ? parseInt(options.listing, 10) : undefined,
      actionType: options.type,
      limit: parseInt(options.limit, 10),
    });

    if (pending.length === 0) {
      console.log('\nNo pending approvals.\n');
      return;
    }

    console.log(`\nShowing ${pending.length} pending approval(s):\n`);

    for (const item of pending) {
      const date = new Date(item.createdAt);
      const formattedDate = date.toLocaleString('en-CA', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });

      console.log(`[#${item.id}] ${item.actionType.toUpperCase()}`);
      console.log(`  ${item.description}`);

      if (item.listingId) {
        const listing = db.getListing(item.listingId);
        if (listing) {
          console.log(`  Listing: #${item.listingId} - ${listing.year} ${listing.make} ${listing.model}`);
        }
      }

      if (item.checkpointType) {
        console.log(`  Checkpoint: ${item.checkpointType}${item.thresholdValue ? ` (threshold: ${item.thresholdValue})` : ''}`);
      }

      if (item.reasoning) {
        console.log(`  Reasoning: ${item.reasoning}`);
      }

      console.log(`  Created: ${formattedDate}`);

      if (item.expiresAt) {
        const expiresDate = new Date(item.expiresAt);
        const expiresFormatted = expiresDate.toLocaleString('en-CA', {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        });
        console.log(`  Expires: ${expiresFormatted}`);
      }

      console.log('');
    }

    console.log('Use "carsearch approve <id>" or "carsearch reject <id>" to resolve.\n');
  });

/**
 * Approve an action
 */
export const approveCommand = new Command('approve')
  .description('Approve a pending action')
  .argument('<id>', 'Approval ID to approve')
  .option('-n, --notes <notes>', 'Add notes to the approval')
  .action(async (id, options) => {
    const db = getDatabase();
    const approvalId = parseInt(id, 10);

    if (isNaN(approvalId)) {
      console.error('Error: Invalid approval ID');
      process.exit(1);
    }

    // Get the pending approval first
    const pending = db.getPendingApprovals({ limit: 1000 });
    const approval = pending.find(p => p.id === approvalId);

    if (!approval) {
      console.error(`Error: Approval #${approvalId} not found or not pending`);
      process.exit(1);
    }

    // Show details and confirm
    console.log('\n📋 Approval Details');
    console.log('─'.repeat(60));
    console.log(`Action: ${approval.actionType}`);
    console.log(`Description: ${approval.description}`);

    if (approval.reasoning) {
      console.log(`Reasoning: ${approval.reasoning}`);
    }

    console.log('\nPayload:');
    console.log(JSON.stringify(approval.payload, null, 2));
    console.log('─'.repeat(60));

    const rl = createReadlineInterface();
    const confirm = await promptUser(rl, '\nApprove this action? [y/n]: ');
    rl.close();

    if (confirm !== 'y' && confirm !== 'yes') {
      console.log('Cancelled.\n');
      return;
    }

    const result = db.approveAction(approvalId, options.notes);

    if (result.success) {
      console.log(`\n✅ Approved! Action payload ready for execution.`);
      console.log('\nTo execute, the automation system will use this payload:');
      console.log(JSON.stringify(result.payload, null, 2));
      console.log('');
    } else {
      console.error(`\n❌ Failed: ${result.error}\n`);
      process.exit(1);
    }
  });

/**
 * Reject an action
 */
export const rejectCommand = new Command('reject')
  .description('Reject a pending action')
  .argument('<id>', 'Approval ID to reject')
  .option('-n, --notes <notes>', 'Add notes explaining the rejection')
  .action(async (id, options) => {
    const db = getDatabase();
    const approvalId = parseInt(id, 10);

    if (isNaN(approvalId)) {
      console.error('Error: Invalid approval ID');
      process.exit(1);
    }

    // Get the pending approval first
    const pending = db.getPendingApprovals({ limit: 1000 });
    const approval = pending.find(p => p.id === approvalId);

    if (!approval) {
      console.error(`Error: Approval #${approvalId} not found or not pending`);
      process.exit(1);
    }

    // Show details and confirm
    console.log('\n📋 Approval Details');
    console.log('─'.repeat(60));
    console.log(`Action: ${approval.actionType}`);
    console.log(`Description: ${approval.description}`);
    console.log('─'.repeat(60));

    const rl = createReadlineInterface();
    let notes = options.notes;

    if (!notes) {
      notes = await promptUser(rl, '\nReason for rejection (optional): ');
    }

    const confirm = await promptUser(rl, '\nReject this action? [y/n]: ');
    rl.close();

    if (confirm !== 'y' && confirm !== 'yes') {
      console.log('Cancelled.\n');
      return;
    }

    const result = db.rejectAction(approvalId, notes || undefined);

    if (result.success) {
      console.log(`\n✅ Rejected. Action will not be executed.\n`);
    } else {
      console.error(`\n❌ Failed: ${result.error}\n`);
      process.exit(1);
    }
  });

/**
 * Interactive approval mode
 */
export const approveInteractiveCommand = new Command('approve-all')
  .description('Interactively review and approve/reject all pending actions')
  .action(async () => {
    const db = getDatabase();
    const config = getCheckpointsConfig();

    if (!config.enabled) {
      console.log('\nCheckpoints are disabled in config.\n');
      return;
    }

    const pending = db.getPendingApprovals();

    if (pending.length === 0) {
      console.log('\nNo pending approvals.\n');
      return;
    }

    console.log(`\n📋 Interactive Approval Mode`);
    console.log(`${pending.length} action(s) pending review\n`);

    const rl = createReadlineInterface();
    let approved = 0;
    let rejected = 0;
    let skipped = 0;

    for (const item of pending) {
      console.log('─'.repeat(60));
      console.log(`\n[#${item.id}] ${item.actionType.toUpperCase()}`);
      console.log(`${item.description}`);

      if (item.listingId) {
        const listing = db.getListing(item.listingId);
        if (listing) {
          console.log(`Listing: #${item.listingId} - ${listing.year} ${listing.make} ${listing.model} - $${listing.price}`);
        }
      }

      if (item.checkpointType) {
        console.log(`Checkpoint: ${item.checkpointType}${item.thresholdValue ? ` (threshold: ${item.thresholdValue})` : ''}`);
      }

      if (item.reasoning) {
        console.log(`Reasoning: ${item.reasoning}`);
      }

      console.log('\nPayload preview:');
      const payloadPreview = JSON.stringify(item.payload, null, 2).slice(0, 300);
      console.log(payloadPreview + (payloadPreview.length >= 300 ? '...' : ''));

      const answer = await promptUser(rl, '\n[a]pprove / [r]eject / [s]kip / [q]uit: ');

      switch (answer) {
        case 'a':
        case 'approve':
          const approveResult = db.approveAction(item.id);
          if (approveResult.success) {
            console.log('✅ Approved');
            approved++;
          } else {
            console.log(`❌ Failed: ${approveResult.error}`);
          }
          break;

        case 'r':
        case 'reject':
          const reason = await promptUser(rl, 'Reason (optional): ');
          const rejectResult = db.rejectAction(item.id, reason || undefined);
          if (rejectResult.success) {
            console.log('✅ Rejected');
            rejected++;
          } else {
            console.log(`❌ Failed: ${rejectResult.error}`);
          }
          break;

        case 's':
        case 'skip':
          console.log('⏭️ Skipped');
          skipped++;
          break;

        case 'q':
        case 'quit':
          console.log('\nExiting...\n');
          rl.close();
          console.log(`Summary: ${approved} approved, ${rejected} rejected, ${skipped} skipped\n`);
          return;

        default:
          console.log('⏭️ Skipped (unknown command)');
          skipped++;
      }
    }

    rl.close();
    console.log('─'.repeat(60));
    console.log(`\nDone! ${approved} approved, ${rejected} rejected, ${skipped} skipped\n`);
  });

/**
 * Show checkpoint configuration
 */
export const checkpointsConfigCommand = new Command('checkpoints')
  .description('Show current checkpoint configuration')
  .action(() => {
    const config = getCheckpointsConfig();

    console.log('\n⚙️ Checkpoint Configuration');
    console.log('─'.repeat(60));
    console.log(`Enabled: ${config.enabled ? 'Yes' : 'No'}`);
    console.log('');
    console.log('Thresholds:');
    console.log(`  Offer approval threshold: $${config.offerApprovalThreshold.toLocaleString()}`);
    console.log(`  Viewing requires approval: ${config.viewingRequiresApproval ? 'Yes' : 'No'}`);

    if (config.portfolioExposureAlert) {
      console.log(`  Portfolio exposure alert: $${config.portfolioExposureAlert.toLocaleString()}`);
    }

    console.log('');
    console.log('Automation limits:');
    console.log(`  Stale negotiation alert: ${config.staleNegotiationDays} days`);
    console.log(`  Auto follow-up after: ${config.autoFollowupDays} days`);
    console.log(`  Max auto follow-ups: ${config.maxAutoFollowups}`);
    console.log('');
    console.log('Edit config/config.local.yaml to change these settings.\n');
  });
