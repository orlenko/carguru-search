#!/usr/bin/env node

import { Command } from 'commander';
import { searchCommand } from './commands/search.js';
import { listCommand } from './commands/list.js';
import { showCommand } from './commands/show.js';
import { statsCommand } from './commands/stats.js';
import { analyzeCommand } from './commands/analyze.js';
import { rankCommand } from './commands/rank.js';
import { contactCommand, checkEmailCommand, checkSmsCommand } from './commands/contact.js';
import { carfaxCommand, scanCarfaxCommand } from './commands/carfax.js';
import { respondCommand, draftCommand } from './commands/respond.js';
import { checkVoicemailCommand, voicemailTwimlCommand } from './commands/voicemail.js';
import { outreachCommand, inboxCommand, autoRespondCommand } from './commands/outreach.js';
import { negotiateCommand, negotiationStatusCommand, autoNegotiateCommand } from './commands/negotiate.js';
import { triageCommand } from './commands/triage.js';
import { exportCommand } from './commands/export.js';
import { pipelineCommand } from './commands/pipeline.js';
import { syncWorkspaceCommand, addEmailCommand, askClaudeCommand, analyzeEmailCommand } from './commands/workspace.js';
import { smartRespondCommand, recommendCommand } from './commands/smart-respond.js';
import { auditCommand } from './commands/audit.js';
import { approvalsListCommand, approveCommand, rejectCommand, approveInteractiveCommand, checkpointsConfigCommand } from './commands/approvals.js';
import { dashboardCommand } from './commands/dashboard.js';
import { costCommand, costAllCommand } from './commands/cost.js';
import { processLinksCommand } from './commands/process-links.js';
import { emailFollowupCommand } from './commands/email-followup.js';
import { rankOffersCommand, aiRankCommand } from './commands/rank-offers.js';

const program = new Command();

program
  .name('carsearch')
  .description('Agentic used car search automation')
  .version('0.1.0');

// Discovery commands
program.addCommand(searchCommand);
program.addCommand(listCommand);
program.addCommand(showCommand);
program.addCommand(statsCommand);

// Analysis commands
program.addCommand(analyzeCommand);
program.addCommand(rankCommand);
program.addCommand(carfaxCommand);
program.addCommand(scanCarfaxCommand);

// Communication commands
program.addCommand(contactCommand);
program.addCommand(draftCommand);
program.addCommand(respondCommand);
program.addCommand(checkEmailCommand);
program.addCommand(checkSmsCommand);
program.addCommand(checkVoicemailCommand);
program.addCommand(voicemailTwimlCommand);

// Automation commands
program.addCommand(outreachCommand);
program.addCommand(inboxCommand);
program.addCommand(autoRespondCommand);

// Negotiation commands
program.addCommand(negotiateCommand);
program.addCommand(negotiationStatusCommand);
program.addCommand(autoNegotiateCommand);

// Batch workflow commands
program.addCommand(triageCommand);
program.addCommand(exportCommand);

// Automation commands
program.addCommand(pipelineCommand);

// Workspace commands (Claude-powered analysis)
program.addCommand(syncWorkspaceCommand);
program.addCommand(addEmailCommand);
program.addCommand(askClaudeCommand);
program.addCommand(analyzeEmailCommand);

// Smart AI-powered commands
program.addCommand(smartRespondCommand);
program.addCommand(recommendCommand);

// Audit and tracking commands
program.addCommand(auditCommand);

// Approval checkpoint commands
program.addCommand(approvalsListCommand);
program.addCommand(approveCommand);
program.addCommand(rejectCommand);
program.addCommand(approveInteractiveCommand);
program.addCommand(checkpointsConfigCommand);

// Portfolio management
program.addCommand(dashboardCommand);

// Cost calculation commands
program.addCommand(costCommand);
program.addCommand(costAllCommand);

// Link processing commands
program.addCommand(processLinksCommand);

// Email follow-up flow
program.addCommand(emailFollowupCommand);

// Ranking commands
program.addCommand(rankOffersCommand);
program.addCommand(aiRankCommand);

program.parse();
