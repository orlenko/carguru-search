import { Command } from 'commander';
import { unlinkSync } from 'fs';
import {
  fetchRecordings,
  processRecording,
  generateVoicemailTwiml,
} from '../../voice/voicemail.js';
import type { Voicemail, ParsedVoicemail } from '../../voice/voicemail.js';

export const checkVoicemailCommand = new Command('check-voicemail')
  .description('Check for new voicemails and transcribe them')
  .option('--since <date>', 'Check voicemails since date (YYYY-MM-DD)')
  .option('--limit <n>', 'Maximum number to fetch', '10')
  .option('--keep-audio', 'Keep downloaded audio files')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    try {
      const since = options.since ? new Date(options.since) : undefined;
      const limit = parseInt(options.limit, 10);

      console.log('\n📞 Checking for voicemails...\n');

      const recordings = await fetchRecordings(since, limit);

      if (recordings.length === 0) {
        console.log('No voicemails found.');
        return;
      }

      console.log(`Found ${recordings.length} recording(s). Processing...\n`);

      const voicemails: Voicemail[] = [];

      for (const recording of recordings) {
        console.log(`Processing ${recording.sid} (${recording.duration}s from ${recording.from})...`);

        const voicemail = await processRecording(recording);
        voicemails.push(voicemail);

        // Clean up audio file unless requested to keep
        if (!options.keepAudio && voicemail.audioPath) {
          try {
            unlinkSync(voicemail.audioPath);
          } catch {}
        }
      }

      if (options.json) {
        console.log(JSON.stringify(voicemails, null, 2));
        return;
      }

      console.log('\n' + '═'.repeat(60) + '\n');

      for (const vm of voicemails) {
        printVoicemail(vm);
        console.log('─'.repeat(60) + '\n');
      }

      // Summary
      const actionRequired = voicemails.filter(vm => vm.parsed?.actionRequired);
      if (actionRequired.length > 0) {
        console.log(`⚡ ${actionRequired.length} voicemail(s) require action:\n`);
        for (const vm of actionRequired) {
          if (vm.parsed?.suggestedAction) {
            console.log(`  • ${vm.recording.from}: ${vm.parsed.suggestedAction}`);
          }
        }
      }
    } catch (error) {
      console.error('Failed to check voicemails:', error);
      console.error('\nMake sure TWILIO_* and OPENAI_API_KEY are set in .env');
      process.exit(1);
    }
  });

export const voicemailTwimlCommand = new Command('voicemail-twiml')
  .description('Generate TwiML for voicemail greeting (for Twilio webhook setup)')
  .option('-g, --greeting <text>', 'Custom greeting message')
  .action((options) => {
    const twiml = generateVoicemailTwiml(options.greeting);
    console.log(twiml);
    console.log('\n---');
    console.log('To use this:');
    console.log('1. Host this TwiML at a public URL (e.g., Twilio Functions, AWS Lambda)');
    console.log('2. Configure your Twilio number\'s voice webhook to point to that URL');
    console.log('3. Or use TwiML Bins in Twilio console for quick testing');
  });

function printVoicemail(vm: Voicemail): void {
  const rec = vm.recording;
  const parsed = vm.parsed;

  console.log(`📞 From: ${rec.from}`);
  console.log(`   Date: ${rec.dateCreated.toLocaleString()}`);
  console.log(`   Duration: ${rec.duration}s`);

  if (parsed) {
    if (parsed.callerName) console.log(`   Caller: ${parsed.callerName}`);
    if (parsed.dealership) console.log(`   Dealership: ${parsed.dealership}`);
    if (parsed.vehicleMentioned) console.log(`   Vehicle: ${parsed.vehicleMentioned}`);
    if (parsed.callbackNumber) console.log(`   Callback: ${parsed.callbackNumber}`);

    const purposeEmoji: Record<string, string> = {
      'inquiry_response': '💬',
      'price_update': '💰',
      'availability': '✅',
      'schedule': '📅',
      'other': '📝',
    };

    console.log(`   Purpose: ${purposeEmoji[parsed.purpose] || '📝'} ${parsed.purpose.replace('_', ' ')}`);
    console.log(`\n   📋 Summary: ${parsed.summary}`);

    if (parsed.actionRequired) {
      console.log(`\n   ⚡ Action: ${parsed.suggestedAction}`);
    }
  }

  if (vm.transcript) {
    console.log(`\n   📝 Transcript:`);
    // Indent and wrap transcript
    const lines = vm.transcript.match(/.{1,70}/g) || [vm.transcript];
    lines.forEach(line => console.log(`      ${line}`));
  }
}
