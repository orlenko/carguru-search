import { Command } from 'commander';
import { getDatabase } from '../../database/index.js';
import { EmailClient, generateEmail, extractDealerEmail, extractDealerPhone } from '../../email/index.js';
import { SmsClient, generateSmsText } from '../../email/sms.js';
import type { EmailTemplate } from '../../email/templates.js';

export const contactCommand = new Command('contact')
  .description('Contact a dealer about a listing')
  .argument('<id>', 'Listing ID')
  .option('-t, --template <template>', 'Email template (initial_inquiry, carfax_request, follow_up)', 'initial_inquiry')
  .option('--sms', 'Send SMS instead of email')
  .option('--email <email>', 'Override dealer email')
  .option('--phone <phone>', 'Override dealer phone (for SMS)')
  .option('--dry-run', 'Show message without sending')
  .action(async (id, options) => {
    try {
      const db = getDatabase();
      const listing = db.getListing(parseInt(id, 10));

      if (!listing) {
        console.error(`Listing #${id} not found.`);
        process.exit(1);
      }

      const vehicle = `${listing.year} ${listing.make} ${listing.model}`;
      console.log(`\n📧 Contacting dealer about: ${vehicle}\n`);

      if (options.sms) {
        // SMS mode
        const phone = options.phone || extractDealerPhone(listing);

        if (!phone) {
          console.error('No phone number found for this listing.');
          console.error('Use --phone <number> to specify one.');
          process.exit(1);
        }

        const smsType = options.template === 'carfax_request' ? 'carfax_request' :
                        options.template === 'follow_up' ? 'follow_up' : 'inquiry';

        const message = generateSmsText(smsType, vehicle);

        console.log('📱 SMS Message:');
        console.log(`To: ${phone}`);
        console.log(`Message: ${message}`);
        console.log('');

        if (options.dryRun) {
          console.log('[Dry run - message not sent]');
          return;
        }

        try {
          const smsClient = new SmsClient();
          const sid = await smsClient.send({ to: phone, body: message });

          // Update listing
          db.updateListing(listing.id, {
            status: 'contacted',
            lastContactedAt: new Date().toISOString(),
            contactAttempts: (listing.contactAttempts || 0) + 1,
          });

          console.log(`✅ SMS sent! (SID: ${sid})`);
        } catch (error) {
          console.error('Failed to send SMS:', error);
          process.exit(1);
        }
      } else {
        // Email mode
        const email = options.email || extractDealerEmail(listing);

        if (!email) {
          console.error('No email found for this listing.');
          console.error('Use --email <address> to specify one.');
          console.error('\nTip: Check the listing URL for contact info:');
          console.log(`  ${listing.sourceUrl}`);
          process.exit(1);
        }

        const template = options.template as EmailTemplate;
        const { subject, text } = generateEmail(template, { listing });

        console.log('📧 Email:');
        console.log(`To: ${email}`);
        console.log(`Subject: ${subject}`);
        console.log('---');
        console.log(text);
        console.log('---');
        console.log('');

        if (options.dryRun) {
          console.log('[Dry run - email not sent]');
          return;
        }

        try {
          const emailClient = new EmailClient();
          const messageId = await emailClient.send({ to: email, subject, text });

          // Update listing
          db.updateListing(listing.id, {
            status: 'contacted',
            lastContactedAt: new Date().toISOString(),
            contactAttempts: (listing.contactAttempts || 0) + 1,
            sellerEmail: email, // Save for future reference
          });

          console.log(`✅ Email sent! (ID: ${messageId})`);
          emailClient.close();
        } catch (error) {
          console.error('Failed to send email:', error);
          console.error('\nMake sure EMAIL_USER and EMAIL_PASSWORD are set in .env');
          process.exit(1);
        }
      }
    } catch (error) {
      console.error('Contact failed:', error);
      process.exit(1);
    }
  });

export const checkEmailCommand = new Command('check-email')
  .description('Check for new emails from dealers')
  .option('--since <date>', 'Check emails since date (YYYY-MM-DD)')
  .action(async (options) => {
    try {
      const emailClient = new EmailClient();

      const since = options.since ? new Date(options.since) : undefined;

      console.log('\n📬 Checking for new emails...\n');

      const emails = await emailClient.fetchNewEmails(since);

      if (emails.length === 0) {
        console.log('No new emails.');
        emailClient.close();
        return;
      }

      console.log(`Found ${emails.length} new email(s):\n`);

      for (const email of emails) {
        console.log('─'.repeat(60));
        console.log(`From: ${email.from}`);
        console.log(`Subject: ${email.subject}`);
        console.log(`Date: ${email.date.toLocaleString()}`);

        if (email.attachments.length > 0) {
          console.log(`📎 Attachments: ${email.attachments.map(a => a.filename).join(', ')}`);

          // Check for CARFAX
          const carfaxAttachment = email.attachments.find(
            a => a.filename.toLowerCase().includes('carfax') ||
                 a.filename.toLowerCase().includes('history')
          );

          if (carfaxAttachment) {
            console.log('  📄 CARFAX report detected!');
            // TODO: Save and analyze CARFAX
          }
        }

        console.log(`\nPreview: ${email.text.slice(0, 200)}...`);
        console.log('');
      }

      emailClient.close();
    } catch (error) {
      console.error('Failed to check email:', error);
      console.error('\nMake sure EMAIL_USER and EMAIL_PASSWORD are set in .env');
      process.exit(1);
    }
  });

export const checkSmsCommand = new Command('check-sms')
  .description('Check for incoming SMS messages')
  .option('--since <date>', 'Check messages since date (YYYY-MM-DD)')
  .action(async (options) => {
    try {
      const smsClient = new SmsClient();

      const since = options.since ? new Date(options.since) : undefined;

      console.log('\n📱 Checking for incoming SMS...\n');

      const messages = await smsClient.fetchIncoming(since);

      if (messages.length === 0) {
        console.log('No new messages.');
        return;
      }

      console.log(`Found ${messages.length} message(s):\n`);

      for (const msg of messages) {
        console.log('─'.repeat(60));
        console.log(`From: ${msg.from}`);
        console.log(`Date: ${msg.dateSent.toLocaleString()}`);
        console.log(`Message: ${msg.body}`);
        console.log('');
      }
    } catch (error) {
      console.error('Failed to check SMS:', error);
      console.error('\nMake sure TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER are set in .env');
      process.exit(1);
    }
  });
