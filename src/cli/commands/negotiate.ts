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

export const negotiateCommand = new Command('negotiate')
  .description('Start or continue price negotiation with a dealer')
  .argument('<id>', 'Listing ID')
  .option('--start', 'Generate opening offer')
  .option('--respond', 'Respond to dealer message (will prompt for input)')
  .option('--target <price>', 'Override target price')
  .option('--walkaway <price>', 'Override walk-away price')
  .option('--send', 'Send the generated message')
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

      // Send if requested
      if (options.send) {
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
        db.updateListing(listing.id, {
          lastContactedAt: new Date().toISOString(),
          contactAttempts: (listing.contactAttempts || 0) + 1,
        });
        emailClient.close();
      } else {
        console.log('\nTo send this message, run again with --send flag.');
      }

    } catch (error) {
      console.error('Negotiation failed:', error);
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
