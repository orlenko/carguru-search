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
import { negotiateCommand, negotiationStatusCommand } from './commands/negotiate.js';

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

program.parse();
