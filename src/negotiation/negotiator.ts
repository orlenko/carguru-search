/**
 * AI-powered price negotiation for email/text-based car buying
 *
 * Key principles for WRITTEN negotiations:
 * - Patience is power (you control timing, no pressure to respond immediately)
 * - Research is leverage (market data, comparables, vehicle history)
 * - Brevity is professional (dealers handle hundreds of emails)
 * - Specificity is credibility (precise numbers with clear justification)
 * - Silence is a tactic (slow responses reduce urgency)
 * - Everything is documented (reference previous statements)
 */

import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execAsync } from '../analyzers/listing-analyzer.js';
import { getEnv } from '../config.js';
import type { Listing } from '../database/client.js';

export interface NegotiationContext {
  listing: Listing;
  targetPrice: number;        // What we want to pay
  walkAwayPrice: number;      // Maximum we'll pay
  marketData?: {
    averagePrice: number;
    lowestPrice: number;
    comparableListings: number;
  };
  conversationHistory: Array<{
    role: 'buyer' | 'seller';
    message: string;
    timestamp: Date;
  }>;
  currentOffer?: number;      // Dealer's current offer
  ourLastOffer?: number;      // Our last counter-offer
  dealerConcessions: string[]; // Things they've agreed to
  stage: 'initial' | 'countering' | 'final' | 'accepted' | 'walked_away';
}

export interface NegotiationResponse {
  message: string;
  tactic: string;
  reasoning: string;
  suggestedOffer?: number;
  shouldEscalateToHuman: boolean;
  escalationReason?: string;
}

const NEGOTIATION_PROMPT = `You are helping negotiate a car purchase via email. Generate professional, concise responses that a real buyer would send.

EFFECTIVE EMAIL NEGOTIATION TACTICS FOR CAR BUYING:

1. MARKET DATA LEVERAGE
   - Reference specific comparable listings ("I found a similar 2016 Grand Caravan with lower mileage listed for $11,500")
   - Cite average market prices ("Based on AutoTrader listings, these typically sell for $X-$Y")
   - Mention time on market if vehicle has been listed long

2. VEHICLE-SPECIFIC LEVERAGE
   - Reference CARFAX issues (accidents, owners, service gaps)
   - Point out listing concerns (high mileage, wear items due, etc.)
   - Note missing information that affects value

3. BUYER LEVERAGE
   - Pre-approved financing / cash ready
   - Flexible on timing (can close quickly OR no rush)
   - Looking at multiple options (creates competition)
   - Serious buyer, not just browsing

4. DEALER-SPECIFIC LEVERAGE (for dealers only)
   - End of month/quarter timing
   - Ask about all-in pricing (OTD - out the door)
   - Request fee breakdown
   - Vehicle age on their lot costs them money

5. RESPONSE TIMING STRATEGY
   - Don't respond immediately to counter-offers (shows you're considering options)
   - Set reasonable deadlines when appropriate ("I need to decide by Friday")

TONE AND FORMAT:
- Keep emails SHORT (3-5 sentences max for most responses)
- Be professional and direct, not manipulative
- Don't over-explain or sound desperate
- One clear ask per email
- No excessive pleasantries or padding

WHAT NOT TO DO:
- Don't reveal your maximum budget
- Don't express too much enthusiasm ("I love this car!")
- Don't use psychological manipulation tactics that sound awkward in writing
- Don't send long rambling emails
- Don't counter immediately - brief pause is fine
- Don't make threats you won't follow through on

OFFER STRATEGY:
- Opening offer: 10-15% below asking (reasonable, not insulting)
- Counter-offers: Move in smaller increments as you approach agreement
- Always justify your number with data or specific concerns
- Use precise numbers ($11,750 not $12,000) - they seem more calculated

CONTEXT:
{context}

CONVERSATION SO FAR:
{history}

DEALER'S LATEST MESSAGE:
{dealer_message}

Generate a response. Keep it brief and professional - this is a real email to send.

Output JSON:
{
  "message": "Your email response (the actual text to send - keep it concise)",
  "tactic": "Brief description of your approach",
  "reasoning": "Why this approach for this situation",
  "suggestedOffer": null or a specific dollar amount if making a counter-offer,
  "shouldEscalateToHuman": false,
  "escalationReason": null
}

Set shouldEscalateToHuman to true ONLY if:
- They've accepted our offer (human needs to confirm and arrange payment/pickup)
- They're asking to schedule a viewing (human decision needed)
- They're asking for personal information beyond email
- Negotiation has stalled after 4+ exchanges with no movement`;

/**
 * Generate a negotiation response using AI
 */
export async function generateNegotiationResponse(
  context: NegotiationContext,
  dealerMessage: string
): Promise<NegotiationResponse> {
  const buyerName = getEnv('BUYER_NAME', false) || 'Buyer';
  const vehicle = `${context.listing.year} ${context.listing.make} ${context.listing.model}`;

  // Build context string
  const contextStr = `
Vehicle: ${vehicle}
Listed Price: $${context.listing.price?.toLocaleString() || 'Unknown'}
Our Target Price: $${context.targetPrice.toLocaleString()}
Walk-Away Price: $${context.walkAwayPrice.toLocaleString()} (DO NOT REVEAL)
Seller Type: ${context.listing.sellerType || 'Unknown'}
Current Stage: ${context.stage}
Exchange Count: ${context.conversationHistory.length}
${context.currentOffer ? `Dealer's Current Offer: $${context.currentOffer.toLocaleString()}` : ''}
${context.ourLastOffer ? `Our Last Offer: $${context.ourLastOffer.toLocaleString()}` : ''}
${context.marketData ? `
Market Data:
  - Average price for similar: $${context.marketData.averagePrice.toLocaleString()}
  - Lowest comparable: $${context.marketData.lowestPrice.toLocaleString()}
  - Comparable listings found: ${context.marketData.comparableListings}
` : ''}
${context.listing.redFlags?.length ? `Vehicle Concerns: ${context.listing.redFlags.join('; ')}` : ''}
${context.listing.carfaxReceived ? `CARFAX: ${context.listing.accidentCount || 0} accidents, ${context.listing.ownerCount || '?'} owners` : ''}
${context.dealerConcessions.length > 0 ? `Dealer has agreed to: ${context.dealerConcessions.join(', ')}` : ''}
`.trim();

  // Build conversation history
  const historyStr = context.conversationHistory.length > 0
    ? context.conversationHistory
        .slice(-6) // Only include last 6 exchanges for context
        .map(h => `${h.role.toUpperCase()}: ${h.message}`)
        .join('\n\n')
    : '(This is the start of price negotiation)';

  const prompt = NEGOTIATION_PROMPT
    .replace('{context}', contextStr)
    .replace('{history}', historyStr)
    .replace('{dealer_message}', dealerMessage);

  const promptFile = join(tmpdir(), `negotiation-${Date.now()}.txt`);
  writeFileSync(promptFile, prompt);

  try {
    const { stdout } = await execAsync(
      `cat "${promptFile}" | claude --print --model sonnet`,
      { timeout: 120000, maxBuffer: 1024 * 1024 }
    );

    // Extract JSON from response
    const jsonMatch = stdout.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON in response');
    }

    const response = JSON.parse(jsonMatch[0]) as NegotiationResponse;
    return response;

  } catch (error) {
    // Fallback response
    return {
      message: `Thanks for getting back to me on the ${vehicle}. I'm still interested but need to consider my options. What's the best you can do on the price?`,
      tactic: 'open_question',
      reasoning: 'Fallback response - keeps negotiation open without committing',
      shouldEscalateToHuman: false,
    };
  } finally {
    try {
      unlinkSync(promptFile);
    } catch {}
  }
}

/**
 * Generate initial negotiation opener
 */
export async function generateOpeningOffer(
  context: NegotiationContext
): Promise<NegotiationResponse> {
  const vehicle = `${context.listing.year} ${context.listing.make} ${context.listing.model}`;
  const listedPrice = context.listing.price || 0;

  // Calculate opening offer (10-15% below listed for email - more reasonable than in-person lowball)
  const discount = 0.12; // 12% below listed
  const rawOffer = listedPrice * (1 - discount);
  // Make it a precise-looking number (suggests calculation, not arbitrary)
  const openingOffer = Math.round(rawOffer / 25) * 25 + 50; // e.g., $11,450 instead of $11,000

  const prompt = `You're writing an opening price negotiation email for a ${vehicle} listed at $${listedPrice.toLocaleString()}.

Your target price is $${context.targetPrice.toLocaleString()} and you'll walk away above $${context.walkAwayPrice.toLocaleString()} (don't reveal this).

Seller type: ${context.listing.sellerType || 'Unknown'}

${context.listing.redFlags?.length ? `Vehicle concerns to reference: ${context.listing.redFlags.join('; ')}` : 'No specific concerns identified yet.'}

${context.marketData ? `Market data: Average is $${context.marketData.averagePrice.toLocaleString()} with ${context.marketData.comparableListings} similar listings. Lowest comparable is $${context.marketData.lowestPrice.toLocaleString()}.` : 'No market data available - focus on vehicle-specific factors.'}

${context.listing.carfaxReceived ? `CARFAX shows: ${context.listing.accidentCount || 0} accidents, ${context.listing.ownerCount || '?'} owners, ${context.listing.serviceRecordCount || '?'} service records.` : ''}

Write a brief opening negotiation email that:
1. References previous communication briefly
2. Makes a specific offer around $${openingOffer.toLocaleString()}
3. Justifies with 1-2 concrete reasons (market data, vehicle concerns, or both)
4. Keeps it SHORT (4-6 sentences total)
5. Ends with an open question

This is a real email to send - keep it natural and professional, not salesy or manipulative.

Output JSON:
{
  "message": "Your email text",
  "tactic": "Brief tactic description",
  "reasoning": "Why this approach",
  "suggestedOffer": ${openingOffer},
  "shouldEscalateToHuman": false,
  "escalationReason": null
}`;

  const promptFile = join(tmpdir(), `negotiation-opener-${Date.now()}.txt`);
  writeFileSync(promptFile, prompt);

  try {
    const { stdout } = await execAsync(
      `cat "${promptFile}" | claude --print --model sonnet`,
      { timeout: 120000, maxBuffer: 1024 * 1024 }
    );

    const jsonMatch = stdout.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON in response');
    }

    return JSON.parse(jsonMatch[0]) as NegotiationResponse;

  } catch (error) {
    // Fallback opener - simple and direct
    const concerns = context.listing.redFlags?.slice(0, 2).join(' and ') || 'some factors';

    return {
      message: `Hi,

Thanks for the info on the ${vehicle}. I'm interested but after reviewing the market and considering ${concerns}, I'd like to offer $${openingOffer.toLocaleString()}.

Would that work for you?`,
      tactic: 'direct_offer_with_justification',
      reasoning: 'Simple opening - states offer with brief justification',
      suggestedOffer: openingOffer,
      shouldEscalateToHuman: false,
    };
  } finally {
    try {
      unlinkSync(promptFile);
    } catch {}
  }
}

/**
 * Determine if we should accept the current offer
 */
export function shouldAcceptOffer(
  currentOffer: number,
  context: NegotiationContext
): { accept: boolean; reason: string } {
  // Accept if at or below target
  if (currentOffer <= context.targetPrice) {
    return {
      accept: true,
      reason: `Offer $${currentOffer.toLocaleString()} meets target price $${context.targetPrice.toLocaleString()}`,
    };
  }

  // Accept if within 3% of target and we've had multiple exchanges
  const exchangeCount = context.conversationHistory.length;
  if (currentOffer <= context.targetPrice * 1.03 && exchangeCount >= 4) {
    return {
      accept: true,
      reason: `Offer $${currentOffer.toLocaleString()} is within 3% of target after ${exchangeCount} exchanges`,
    };
  }

  // Reject if above walk-away
  if (currentOffer > context.walkAwayPrice) {
    return {
      accept: false,
      reason: `Offer $${currentOffer.toLocaleString()} exceeds walk-away price $${context.walkAwayPrice.toLocaleString()}`,
    };
  }

  // Continue negotiating
  return {
    accept: false,
    reason: `Offer $${currentOffer.toLocaleString()} is above target $${context.targetPrice.toLocaleString()} - room to negotiate`,
  };
}

/**
 * Calculate target and walk-away prices based on listing and budget
 */
export function calculateNegotiationPrices(
  listing: Listing,
  budget: number,
  marketAverage?: number
): { targetPrice: number; walkAwayPrice: number } {
  const listedPrice = listing.price || budget;

  // Target: 10-15% below listed, or below market average
  let targetPrice: number;
  if (marketAverage && marketAverage < listedPrice) {
    // If market average is below listed, target 5% below market average
    targetPrice = marketAverage * 0.95;
  } else {
    // Otherwise target 12% below listed
    targetPrice = listedPrice * 0.88;
  }

  // Ensure target is realistic (not below 75% of listed - would be insulting)
  targetPrice = Math.max(targetPrice, listedPrice * 0.75);

  // Walk-away: budget minus estimated fees (~15% for taxes/fees/safety), or listed price
  // We'll pay up to listed price if we have to, but not more
  const budgetAfterFees = budget * 0.85;
  const walkAwayPrice = Math.min(budgetAfterFees, listedPrice);

  return {
    targetPrice: Math.round(targetPrice),
    walkAwayPrice: Math.round(walkAwayPrice),
  };
}

/**
 * Calculate next counter-offer based on negotiation progress
 */
export function calculateCounterOffer(context: NegotiationContext): number {
  const ourLast = context.ourLastOffer || context.targetPrice;
  const theirOffer = context.currentOffer || context.listing.price || ourLast;

  // Gap between positions
  const gap = theirOffer - ourLast;

  // Move 20-30% of the gap, with smaller moves as we get closer
  const exchangeCount = context.conversationHistory.length;
  const movePercent = Math.max(0.15, 0.35 - (exchangeCount * 0.05)); // Decreases with each exchange

  const rawCounter = ourLast + (gap * movePercent);

  // Don't exceed walk-away
  const counter = Math.min(rawCounter, context.walkAwayPrice);

  // Make it a precise number
  return Math.round(counter / 25) * 25 + (counter % 100 > 50 ? 75 : 25);
}
