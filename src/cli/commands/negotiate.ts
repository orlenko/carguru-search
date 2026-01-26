import { Command } from 'commander';
import { createInterface } from 'readline';
import { loadConfig } from '../../config.js';
import { getDatabase } from '../../database/index.js';
import {
  generateNegotiationResponse,
  generateOpeningOffer,
  calculateNegotiationPrices,
  shouldAcceptOffer,
  type NegotiationContext,
} from '../../negotiation/negotiator.js';
import { EmailClient } from '../../email/client.js';

/**
 * Check if an email should be skipped (automated, noreply, marketing, etc.)
 */
function shouldSkipEmail(email: { from: string; subject: string; text: string }): { skip: boolean; reason: string } {
  const fromLower = email.from.toLowerCase();
  const subjectLower = email.subject.toLowerCase();

  if (fromLower.includes('noreply') || fromLower.includes('no-reply') || fromLower.includes('donotreply')) {
    return { skip: true, reason: 'noreply address' };
  }

  const automatedPatterns = [
    'mailer-daemon', 'postmaster', 'autoresponder', 'auto-reply', 'automated',
    'notification@', 'notifications@', 'alert@', 'alerts@', 'system@',
  ];
  for (const pattern of automatedPatterns) {
    if (fromLower.includes(pattern)) {
      return { skip: true, reason: 'automated address' };
    }
  }

  const marketingSubjects = [
    'subscription confirmed', 'you\'re subscribed', 'welcome to', 'thank you for signing up',
    'price alert', 'price drop', 'similar vehicles', 'new listings', 'unsubscribe',
  ];
  for (const pattern of marketingSubjects) {
    if (subjectLower.includes(pattern)) {
      return { skip: true, reason: 'marketing email' };
    }
  }

  return { skip: false, reason: '' };
}

// Safety limits for auto-send mode
const AUTO_SEND_DEFAULTS = {
  maxExchanges: 6,        // Stop auto-negotiating after this many exchanges
  maxOfferPercent: 0.95,  // Never offer more than 95% of walk-away price automatically
};

export const negotiateCommand = new Command('negotiate')
  .description('Start or continue price negotiation with a dealer')
  .argument('<id>', 'Listing ID')
  .option('--start', 'Generate opening offer')
  .option('--respond', 'Respond to dealer message (will prompt for input)')
  .option('--target <price>', 'Override target price')
  .option('--walkaway <price>', 'Override walk-away price')
  .option('--send', 'Send the generated message')
  .option('--auto-send', 'Automatically send without confirmation (use with caution)')
  .option('--max-offer <price>', 'Maximum offer for auto-send mode (safety limit)')
  .option('--max-exchanges <n>', 'Maximum exchanges before stopping auto-send', String(AUTO_SEND_DEFAULTS.maxExchanges))
  .option('--email <email>', 'Override dealer email')
  .action(async (id, options) => {
    try {
      const config = loadConfig();
      const db = getDatabase();
      const listing = db.getListing(parseInt(id, 10));

      if (!listing) {
        console.error(`Listing #${id} not found.`);
        process.exit(1);
      }

      const vehicle = `${listing.year} ${listing.make} ${listing.model}`;
      const budget = config.search.priceMax || 18000;

      console.log(`\n💰 Price Negotiation: ${vehicle}\n`);
      console.log(`Listed Price: $${listing.price?.toLocaleString() || 'Unknown'}`);

      // Calculate negotiation prices
      const { targetPrice, walkAwayPrice } = calculateNegotiationPrices(listing, budget);
      const finalTarget = options.target ? parseInt(options.target, 10) : targetPrice;
      const finalWalkAway = options.walkaway ? parseInt(options.walkaway, 10) : walkAwayPrice;

      console.log(`Target Price: $${finalTarget.toLocaleString()}`);
      console.log(`Walk-Away: $${finalWalkAway.toLocaleString()}`);
      console.log(`Budget: $${budget.toLocaleString()}`);

      // Build negotiation context
      const context: NegotiationContext = {
        listing,
        targetPrice: finalTarget,
        walkAwayPrice: finalWalkAway,
        conversationHistory: [],
        dealerConcessions: [],
        stage: 'initial',
      };

      // Load any existing negotiation notes
      if (listing.notes) {
        try {
          const savedContext = JSON.parse(listing.notes);
          if (savedContext.conversationHistory) {
            context.conversationHistory = savedContext.conversationHistory;
            context.stage = savedContext.stage || 'countering';
            context.currentOffer = savedContext.currentOffer;
            context.ourLastOffer = savedContext.ourLastOffer;
            context.dealerConcessions = savedContext.dealerConcessions || [];
            console.log(`\nLoaded ${context.conversationHistory.length} previous exchanges.`);
          }
        } catch {
          // Not JSON, that's fine
        }
      }

      let response;

      if (options.start) {
        // Generate opening offer
        console.log('\n🎯 Generating opening offer...\n');
        response = await generateOpeningOffer(context);
        context.ourLastOffer = response.suggestedOffer;
        context.stage = 'countering';

      } else if (options.respond) {
        // Get dealer's message
        console.log('\nPaste the dealer\'s message (press Ctrl+D when done):');
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

        const dealerMessage = lines.join('\n');

        if (!dealerMessage.trim()) {
          console.error('\nNo message provided.');
          process.exit(1);
        }

        // Add to history
        context.conversationHistory.push({
          role: 'seller',
          message: dealerMessage,
          timestamp: new Date(),
        });

        // Check if they mentioned a specific price
        const priceMatch = dealerMessage.match(/\$?([\d,]+)/g);
        if (priceMatch) {
          const prices = priceMatch.map(p => parseInt(p.replace(/[$,]/g, ''), 10)).filter(p => p > 5000);
          if (prices.length > 0) {
            context.currentOffer = Math.min(...prices);
            console.log(`\nDetected price mention: $${context.currentOffer.toLocaleString()}`);

            // Check if we should accept
            const acceptCheck = shouldAcceptOffer(context.currentOffer, context);
            console.log(`Assessment: ${acceptCheck.reason}`);

            if (acceptCheck.accept) {
              console.log('\n✅ This offer is within acceptable range!');
              console.log('Generating acceptance response...');
              context.stage = 'final';
            }
          }
        }

        console.log('\n🎯 Generating response...\n');
        response = await generateNegotiationResponse(context, dealerMessage);

        if (response.suggestedOffer) {
          context.ourLastOffer = response.suggestedOffer;
        }

      } else {
        console.log('\nUsage:');
        console.log('  --start    Generate opening negotiation message');
        console.log('  --respond  Respond to dealer message');
        return;
      }

      // Display the response
      console.log('─'.repeat(60));
      console.log('GENERATED MESSAGE:');
      console.log('─'.repeat(60));
      console.log(response.message);
      console.log('─'.repeat(60));

      console.log(`\n📋 Tactic: ${response.tactic}`);
      console.log(`💭 Reasoning: ${response.reasoning}`);

      if (response.suggestedOffer) {
        console.log(`💵 Suggested Offer: $${response.suggestedOffer.toLocaleString()}`);
      }

      if (response.shouldEscalateToHuman) {
        console.log(`\n⚠️  HUMAN ATTENTION NEEDED: ${response.escalationReason}`);
      }

      // Auto-send safety checks
      let autoSendBlocked = false;
      let blockReason = '';

      if (options.autoSend) {
        const maxExchanges = parseInt(options.maxExchanges, 10) || AUTO_SEND_DEFAULTS.maxExchanges;
        const maxOffer = options.maxOffer
          ? parseInt(options.maxOffer, 10)
          : Math.round(finalWalkAway * AUTO_SEND_DEFAULTS.maxOfferPercent);

        // Check safety conditions
        if (response.shouldEscalateToHuman) {
          autoSendBlocked = true;
          blockReason = `AI requested human attention: ${response.escalationReason}`;
        } else if (context.conversationHistory.length >= maxExchanges) {
          autoSendBlocked = true;
          blockReason = `Reached max exchanges limit (${maxExchanges})`;
        } else if (response.suggestedOffer && response.suggestedOffer > maxOffer) {
          autoSendBlocked = true;
          blockReason = `Suggested offer $${response.suggestedOffer.toLocaleString()} exceeds max-offer limit $${maxOffer.toLocaleString()}`;
        } else if (context.stage === 'final' || context.stage === 'accepted') {
          autoSendBlocked = true;
          blockReason = `Negotiation reached ${context.stage} stage - human confirmation required`;
        }

        if (autoSendBlocked) {
          console.log(`\n🛑 AUTO-SEND BLOCKED: ${blockReason}`);
          console.log('   Run with --send to manually review and send.');
        }
      }

      // Save context to listing notes
      context.conversationHistory.push({
        role: 'buyer',
        message: response.message,
        timestamp: new Date(),
      });

      const contextToSave = {
        conversationHistory: context.conversationHistory,
        stage: context.stage,
        currentOffer: context.currentOffer,
        ourLastOffer: context.ourLastOffer,
        dealerConcessions: context.dealerConcessions,
      };

      db.updateListing(listing.id, {
        notes: JSON.stringify(contextToSave, null, 2),
      });
      console.log('\n💾 Negotiation context saved.');

      // Send if requested (--send or --auto-send without block)
      const shouldSend = options.send || (options.autoSend && !autoSendBlocked);

      if (shouldSend) {
        const email = options.email || listing.sellerEmail;

        if (!email) {
          console.error('\nNo email address available. Use --email to specify one.');
          process.exit(1);
        }

        const emailClient = new EmailClient();
        const messageId = await emailClient.send({
          to: email,
          subject: `Re: ${vehicle}`,
          text: response.message,
        });

        console.log(`\n✅ Message sent! (ID: ${messageId})`);
        if (options.autoSend) {
          console.log('   (auto-send mode)');
        }
        db.updateListing(listing.id, {
          lastContactedAt: new Date().toISOString(),
          contactAttempts: (listing.contactAttempts || 0) + 1,
        });
        emailClient.close();
      } else if (!options.autoSend) {
        console.log('\nTo send this message, run again with --send flag.');
        console.log('Or use --auto-send for automatic sending (with safety limits).');
      }

    } catch (error) {
      console.error('Negotiation failed:', error);
      process.exit(1);
    }
  });

export const autoNegotiateCommand = new Command('auto-negotiate')
  .description('Automatically respond to dealer negotiation emails')
  .option('--dry-run', 'Show what would be done without sending')
  .option('--max-offer <price>', 'Maximum offer amount (safety limit)')
  .option('--max-exchanges <n>', 'Maximum exchanges per listing', '6')
  .action(async (options) => {
    try {
      const config = loadConfig();
      const db = getDatabase();
      const budget = config.search.priceMax || 18000;

      console.log('\n🤖 Auto-Negotiate: Processing dealer responses...\n');

      const emailClient = new EmailClient();
      const emails = await emailClient.fetchNewEmails();

      if (emails.length === 0) {
        console.log('No new emails to process.');
        emailClient.close();
        return;
      }

      console.log(`Found ${emails.length} new email(s)\n`);

      // Get listings that are in negotiation or contacted
      const listings = db.listListings({ status: ['contacted', 'interesting'] as any, limit: 100 });
      const maxExchanges = parseInt(options.maxExchanges, 10);

      let processed = 0;
      let sent = 0;
      let blocked = 0;

      for (const email of emails) {
        console.log('─'.repeat(60));
        console.log(`From: ${email.from}`);
        console.log(`Subject: ${email.subject}`);

        // Skip noreply/automated/marketing emails
        const skipCheck = shouldSkipEmail(email);
        if (skipCheck.skip) {
          console.log(`  ⏭️  Skipping: ${skipCheck.reason}`);
          continue;
        }

        // Match to listing
        const matchedListing = listings.find(listing => {
          if (listing.sellerEmail && email.from.includes(listing.sellerEmail)) return true;
          if (listing.sellerName && email.from.toLowerCase().includes(listing.sellerName.toLowerCase())) return true;
          const vehicle = `${listing.make} ${listing.model}`.toLowerCase();
          if (email.subject.toLowerCase().includes(vehicle)) return true;
          return false;
        });

        if (!matchedListing) {
          console.log('  ❓ No matching listing found');
          continue;
        }

        const vehicle = `${matchedListing.year} ${matchedListing.make} ${matchedListing.model}`;
        console.log(`  ✅ Matched: #${matchedListing.id} ${vehicle}`);
        processed++;

        // Load negotiation context
        const { targetPrice, walkAwayPrice } = calculateNegotiationPrices(matchedListing, budget);
        const maxOffer = options.maxOffer
          ? parseInt(options.maxOffer, 10)
          : Math.round(walkAwayPrice * AUTO_SEND_DEFAULTS.maxOfferPercent);

        const context: NegotiationContext = {
          listing: matchedListing,
          targetPrice,
          walkAwayPrice,
          conversationHistory: [],
          dealerConcessions: [],
          stage: 'countering',
        };

        // Load existing context
        if (matchedListing.notes) {
          try {
            const saved = JSON.parse(matchedListing.notes);
            if (saved.conversationHistory) {
              context.conversationHistory = saved.conversationHistory;
              context.stage = saved.stage || 'countering';
              context.currentOffer = saved.currentOffer;
              context.ourLastOffer = saved.ourLastOffer;
              context.dealerConcessions = saved.dealerConcessions || [];
            }
          } catch {}
        }

        // Check exchange limit
        if (context.conversationHistory.length >= maxExchanges) {
          console.log(`  🛑 Skipped: Max exchanges reached (${maxExchanges})`);
          blocked++;
          continue;
        }

        // Add dealer's message to history
        context.conversationHistory.push({
          role: 'seller',
          message: email.text,
          timestamp: new Date(),
        });

        // Check for price mention
        const priceMatch = email.text.match(/\$?([\d,]+)/g);
        if (priceMatch) {
          const prices = priceMatch.map(p => parseInt(p.replace(/[$,]/g, ''), 10)).filter(p => p > 5000);
          if (prices.length > 0) {
            context.currentOffer = Math.min(...prices);
            console.log(`  💵 Detected offer: $${context.currentOffer.toLocaleString()}`);

            const acceptCheck = shouldAcceptOffer(context.currentOffer, context);
            if (acceptCheck.accept) {
              console.log(`  ✅ Acceptable offer! Human confirmation needed.`);
              context.stage = 'final';
              blocked++;

              // Save context but don't auto-respond
              db.updateListing(matchedListing.id, {
                notes: JSON.stringify({
                  conversationHistory: context.conversationHistory,
                  stage: context.stage,
                  currentOffer: context.currentOffer,
                  ourLastOffer: context.ourLastOffer,
                  dealerConcessions: context.dealerConcessions,
                }, null, 2),
              });
              continue;
            }
          }
        }

        // Generate response
        console.log('  🎯 Generating response...');
        const response = await generateNegotiationResponse(context, email.text);

        console.log(`  📋 Tactic: ${response.tactic}`);
        if (response.suggestedOffer) {
          console.log(`  💵 Counter-offer: $${response.suggestedOffer.toLocaleString()}`);
        }

        // Safety checks
        let shouldBlock = false;
        let blockReason = '';

        if (response.shouldEscalateToHuman) {
          shouldBlock = true;
          blockReason = response.escalationReason || 'AI requested human review';
        } else if (response.suggestedOffer && response.suggestedOffer > maxOffer) {
          shouldBlock = true;
          blockReason = `Offer exceeds max-offer limit ($${maxOffer.toLocaleString()})`;
        } else if (context.stage === 'final') {
          shouldBlock = true;
          blockReason = 'Deal near completion - human confirmation needed';
        }

        if (shouldBlock) {
          console.log(`  🛑 Blocked: ${blockReason}`);
          blocked++;

          // Save context
          context.conversationHistory.push({
            role: 'buyer',
            message: `[DRAFT - NOT SENT]\n${response.message}`,
            timestamp: new Date(),
          });
        } else if (!options.dryRun) {
          // Send the response
          const emailMatch = email.from.match(/<(.+)>/) || [null, email.from];
          const replyTo = emailMatch[1];

          await emailClient.send({
            to: replyTo,
            subject: `Re: ${email.subject}`,
            text: response.message,
          });

          console.log(`  ✅ Response sent to ${replyTo}`);
          sent++;

          context.conversationHistory.push({
            role: 'buyer',
            message: response.message,
            timestamp: new Date(),
          });

          if (response.suggestedOffer) {
            context.ourLastOffer = response.suggestedOffer;
          }

          db.updateListing(matchedListing.id, {
            lastContactedAt: new Date().toISOString(),
            contactAttempts: (matchedListing.contactAttempts || 0) + 1,
          });
        } else {
          console.log('  [DRY RUN] Would send response');
          context.conversationHistory.push({
            role: 'buyer',
            message: response.message,
            timestamp: new Date(),
          });
        }

        // Save updated context
        db.updateListing(matchedListing.id, {
          notes: JSON.stringify({
            conversationHistory: context.conversationHistory,
            stage: context.stage,
            currentOffer: context.currentOffer,
            ourLastOffer: context.ourLastOffer,
            dealerConcessions: context.dealerConcessions,
          }, null, 2),
        });
      }

      emailClient.close();

      console.log('\n' + '═'.repeat(60));
      console.log('📊 Auto-Negotiate Summary');
      console.log(`  Emails processed: ${processed}`);
      console.log(`  Responses sent: ${sent}`);
      console.log(`  Blocked (need human): ${blocked}`);

      if (blocked > 0) {
        console.log('\n⚠️  Some negotiations need human attention.');
        console.log('   Run `npm run dev -- negotiation-status` to review.');
      }

      if (options.dryRun) {
        console.log('\n[DRY RUN - No emails sent]');
      }
    } catch (error) {
      console.error('Auto-negotiate failed:', error);
      process.exit(1);
    }
  });

export const negotiationStatusCommand = new Command('negotiation-status')
  .description('Show negotiation status for all active negotiations')
  .action(async () => {
    try {
      const db = getDatabase();
      const config = loadConfig();
      const budget = config.search.priceMax || 18000;

      // Get contacted listings
      const contacted = db.listListings({ status: 'contacted', limit: 100 });

      console.log('\n💰 Active Negotiations\n');

      let activeCount = 0;

      for (const listing of contacted) {
        if (!listing.notes) continue;

        try {
          const context = JSON.parse(listing.notes);
          if (!context.conversationHistory) continue;

          activeCount++;
          const vehicle = `${listing.year} ${listing.make} ${listing.model}`;

          console.log('─'.repeat(60));
          console.log(`#${listing.id}: ${vehicle}`);
          console.log(`Listed: $${listing.price?.toLocaleString()} | Stage: ${context.stage || 'unknown'}`);

          if (context.currentOffer) {
            console.log(`Dealer's offer: $${context.currentOffer.toLocaleString()}`);
          }
          if (context.ourLastOffer) {
            console.log(`Our last offer: $${context.ourLastOffer.toLocaleString()}`);
          }

          console.log(`Exchanges: ${context.conversationHistory.length}`);

          // Show last exchange
          if (context.conversationHistory.length > 0) {
            const last = context.conversationHistory[context.conversationHistory.length - 1];
            console.log(`Last (${last.role}): ${last.message.slice(0, 80)}...`);
          }

          console.log('');
        } catch {
          // Not JSON or no negotiation data
        }
      }

      if (activeCount === 0) {
        console.log('No active negotiations.');
        console.log('\nTo start negotiating:');
        console.log('  carsearch negotiate <id> --start');
      } else {
        console.log('─'.repeat(60));
        console.log(`\nTotal: ${activeCount} active negotiation(s)`);
      }

    } catch (error) {
      console.error('Failed to show status:', error);
      process.exit(1);
    }
  });
