import { Command } from 'commander';
import { createInterface } from 'readline';
import { getDatabase } from '../../database/index.js';
import { generateAIResponse, generateEmail } from '../../email/templates.js';
import { EmailClient } from '../../email/client.js';

export const respondCommand = new Command('respond')
  .description('Generate an AI-assisted response to a dealer email')
  .argument('<id>', 'Listing ID to respond about')
  .option('-c, --context <context>', 'Additional context (e.g., "they asked about timing")')
  .option('--send', 'Send the email after approval')
  .option('--email <email>', 'Override dealer email')
  .action(async (id, options) => {
    try {
      const db = getDatabase();
      const listing = db.getListing(parseInt(id, 10));

      if (!listing) {
        console.error(`Listing #${id} not found.`);
        process.exit(1);
      }

      const vehicle = `${listing.year} ${listing.make} ${listing.model}`;
      console.log(`\n💬 Generate response for: ${vehicle}\n`);

      // Read the dealer's email from stdin
      console.log('Paste the dealer\'s email (press Ctrl+D when done):');
      console.log('─'.repeat(40));

      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: false,
      });

      const lines: string[] = [];
      for await (const line of rl) {
        lines.push(line);
      }

      const dealerEmail = lines.join('\n');

      if (!dealerEmail.trim()) {
        console.error('\nNo email content provided.');
        process.exit(1);
      }

      console.log('─'.repeat(40));
      console.log('\n🤖 Generating response...\n');

      const context = options.context || 'Buyer is interested in scheduling a viewing if the vehicle checks out.';
      const response = await generateAIResponse(dealerEmail, listing, context);

      console.log('─'.repeat(60));
      console.log('GENERATED RESPONSE:');
      console.log('─'.repeat(60));
      console.log(response);
      console.log('─'.repeat(60));

      if (options.send) {
        const email = options.email || listing.sellerEmail;

        if (!email) {
          console.error('\nNo email address available. Use --email to specify one.');
          process.exit(1);
        }

        console.log(`\n📧 Ready to send to: ${email}`);
        console.log('Confirm? (y/N): ');

        // Simple confirmation
        const confirmRl = createInterface({
          input: process.stdin,
          output: process.stdout,
        });

        const answer = await new Promise<string>(resolve => {
          confirmRl.question('', resolve);
        });
        confirmRl.close();

        if (answer.toLowerCase() === 'y') {
          const emailClient = new EmailClient();
          const messageId = await emailClient.send({
            to: email,
            subject: `Re: ${vehicle}`,
            text: response,
          });

          console.log(`\n✅ Email sent! (ID: ${messageId})`);

          // Update listing
          db.updateListing(listing.id, {
            lastContactedAt: new Date().toISOString(),
            lastOurResponseAt: new Date().toISOString(),
            contactAttempts: (listing.contactAttempts || 0) + 1,
          });

          emailClient.close();
        } else {
          console.log('\nEmail not sent.');
        }
      } else {
        console.log('\nTo send this response, run again with --send flag.');
      }
    } catch (error) {
      console.error('Failed to generate response:', error);
      process.exit(1);
    }
  });

export const draftCommand = new Command('draft')
  .description('Create a draft email for a listing')
  .argument('<id>', 'Listing ID')
  .argument('<template>', 'Template: initial_inquiry, carfax_request, follow_up, price_inquiry, schedule_viewing')
  .option('-m, --message <message>', 'Custom message to include')
  .option('--send', 'Send the email after showing')
  .option('--email <email>', 'Override dealer email')
  .action(async (id, template, options) => {
    try {
      const db = getDatabase();
      const listing = db.getListing(parseInt(id, 10));

      if (!listing) {
        console.error(`Listing #${id} not found.`);
        process.exit(1);
      }

      const vehicle = `${listing.year} ${listing.make} ${listing.model}`;
      const { subject, text } = generateEmail(template, {
        listing,
        customMessage: options.message,
      });

      console.log(`\n📧 Draft email for: ${vehicle}\n`);
      console.log(`Subject: ${subject}`);
      console.log('─'.repeat(60));
      console.log(text);
      console.log('─'.repeat(60));

      if (options.send) {
        const email = options.email || listing.sellerEmail;

        if (!email) {
          console.error('\nNo email address available. Use --email to specify one.');
          console.error('Tip: Check the listing URL for contact info.');
          process.exit(1);
        }

        console.log(`\n📧 Send to: ${email}? (y/N): `);

        const rl = createInterface({
          input: process.stdin,
          output: process.stdout,
        });

        const answer = await new Promise<string>(resolve => {
          rl.question('', resolve);
        });
        rl.close();

        if (answer.toLowerCase() === 'y') {
          const emailClient = new EmailClient();
          const messageId = await emailClient.send({
            to: email,
            subject,
            text,
          });

          console.log(`\n✅ Email sent! (ID: ${messageId})`);

          const infoStatus = template === 'carfax_request' || template === 'initial_inquiry'
            ? 'carfax_requested'
            : undefined;
          db.updateListing(listing.id, {
            lastContactedAt: new Date().toISOString(),
            contactAttempts: (listing.contactAttempts || 0) + 1,
            sellerEmail: email,
            ...(infoStatus ? { infoStatus } : {}),
          });
          if (listing.status === 'analyzed' || listing.status === 'contacted' || listing.status === 'awaiting_response') {
            const transitionResult = db.transitionStatePath(listing.id, 'awaiting_response', {
              triggeredBy: 'user',
              reasoning: `Manual email sent (${template})`,
            });
            if (!transitionResult.success) {
              console.log(`⚠️ State transition failed: ${transitionResult.error}`);
            }
          }

          emailClient.close();
        } else {
          console.log('\nEmail not sent.');
        }
      }
    } catch (error) {
      console.error('Failed to create draft:', error);
      process.exit(1);
    }
  });
