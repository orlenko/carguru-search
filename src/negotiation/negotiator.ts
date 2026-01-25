/**
 * AI-powered price negotiation using tactics from "Never Split the Difference"
 *
 * Key principles:
 * - Never split the difference (don't meet in the middle)
 * - Use calibrated questions to make them solve your problem
 * - Label emotions to defuse them
 * - Mirror to build rapport and gather info
 * - Get to "no" - people feel safe saying no
 * - Use precise numbers (they seem more credible)
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

const NEGOTIATION_PROMPT = `You are an expert car buyer negotiator using tactics from "Never Split the Difference" by Chris Voss. You're negotiating on behalf of a buyer who wants a fair deal but won't be manipulated.

KEY TACTICS TO USE:
1. MIRRORING: Repeat the last 1-3 critical words they said. This builds rapport and gets them talking.
   Example: Dealer says "The price is firm because of the low mileage"
   You say: "The low mileage?"

2. LABELING: Identify and verbalize their feelings/position. Start with "It seems like...", "It sounds like...", "It looks like..."
   Example: "It sounds like you've had a lot of interest in this vehicle."

3. CALIBRATED QUESTIONS: Ask "How" and "What" questions that make them solve your problem.
   - "How am I supposed to do that?" (when price is too high)
   - "What would it take to make this work?"
   - "How can we bridge this gap?"

4. GETTING TO NO: Ask questions designed to get "no" - it makes people feel safe and in control.
   - "Is it a ridiculous idea to consider $X?"
   - "Would it be unreasonable to ask for..."

5. PRECISE NUMBERS: Use specific numbers like $12,847 instead of $13,000. They seem more calculated and credible.

6. ACCUSATION AUDIT: Preemptively acknowledge negatives before they bring them up.
   - "You're probably going to think I'm being unreasonable, but..."
   - "I know this might seem like a lowball offer..."

7. THE LATE-NIGHT FM DJ VOICE: Keep tone calm, slow, and reassuring (convey this in word choice).

8. NEVER SPLIT THE DIFFERENCE: Don't offer to meet in the middle. Make them move toward you.

RULES:
- Never reveal the maximum budget or walk-away price
- Always justify offers with objective criteria (market data, vehicle issues, etc.)
- Be respectful but firm - don't apologize for negotiating
- If they use pressure tactics ("another buyer coming"), don't react emotionally
- If they won't budge at all after 3 exchanges, consider walking away
- Reference specific issues from the listing or CARFAX if available

CONTEXT:
{context}

CONVERSATION SO FAR:
{history}

DEALER'S LATEST MESSAGE:
{dealer_message}

Generate a response. Output JSON:
{
  "message": "Your response to the dealer (the actual text to send)",
  "tactic": "Which tactic(s) you're using",
  "reasoning": "Why this approach for this situation",
  "suggestedOffer": null or a specific dollar amount if making a counter-offer,
  "shouldEscalateToHuman": false,
  "escalationReason": null
}

Set shouldEscalateToHuman to true ONLY if:
- They've accepted our offer (need human to confirm and schedule)
- We've reached an impasse after multiple attempts
- They're asking to schedule a viewing (human decision)
- Something unusual requires human judgment`;

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
Walk-Away Price: $${context.walkAwayPrice.toLocaleString()} (DO NOT REVEAL THIS)
Current Stage: ${context.stage}
${context.currentOffer ? `Dealer's Current Offer: $${context.currentOffer.toLocaleString()}` : ''}
${context.ourLastOffer ? `Our Last Offer: $${context.ourLastOffer.toLocaleString()}` : ''}
${context.marketData ? `
Market Data:
  - Average price for similar vehicles: $${context.marketData.averagePrice.toLocaleString()}
  - Lowest comparable listing: $${context.marketData.lowestPrice.toLocaleString()}
  - Number of comparable listings: ${context.marketData.comparableListings}
` : ''}
${context.dealerConcessions.length > 0 ? `Dealer has agreed to: ${context.dealerConcessions.join(', ')}` : ''}
Listing Issues/Concerns: ${context.listing.redFlags?.join(', ') || 'None identified'}
`.trim();

  // Build conversation history
  const historyStr = context.conversationHistory.length > 0
    ? context.conversationHistory
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
      `cat "${promptFile}" | claude --print --model sonnet`,  // Use Sonnet for nuanced negotiation
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
      message: `Thank you for your response about the ${vehicle}. I'm still very interested, but I need to consider my options carefully. What's the best you can do on the price?`,
      tactic: 'calibrated_question',
      reasoning: 'Fallback response - keeps negotiation open',
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

  // Calculate opening offer (typically 15-25% below listed)
  // Use a precise number for credibility
  const discount = 0.20; // 20% below listed
  const rawOffer = listedPrice * (1 - discount);
  // Make it a precise-looking number
  const openingOffer = Math.round(rawOffer / 50) * 50 + 47; // e.g., $10,347 instead of $10,000

  const prompt = `You're starting a price negotiation for a ${vehicle} listed at $${listedPrice.toLocaleString()}.

Your target price is $${context.targetPrice.toLocaleString()} and you'll walk away above $${context.walkAwayPrice.toLocaleString()}.

${context.listing.redFlags?.length ? `Known issues with this vehicle: ${context.listing.redFlags.join(', ')}` : ''}

${context.marketData ? `Market data shows average price is $${context.marketData.averagePrice.toLocaleString()} with ${context.marketData.comparableListings} comparable listings.` : ''}

Generate an opening message that:
1. Thanks them for previous communication
2. Expresses continued interest
3. Uses an accusation audit ("You're probably going to think...")
4. Makes a precise opening offer around $${openingOffer.toLocaleString()}
5. Justifies with objective criteria (market data, vehicle age, issues found, etc.)
6. Asks a calibrated question

Keep it professional and concise. This is via email/text.

Output JSON:
{
  "message": "Your opening negotiation message",
  "tactic": "accusation_audit, precise_number, calibrated_question",
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
    // Fallback opener
    return {
      message: `Hi,

Thank you for the information about the ${vehicle}. I'm very interested in this vehicle for my family.

I've done some research on comparable ${context.listing.year} ${context.listing.model}s in the area, and I was hoping we could discuss the price. You're probably going to think I'm being a tough negotiator here, but based on the market data I've seen, would you consider $${openingOffer.toLocaleString()}?

I understand if that's not where you need to be - what would it take to make this work for both of us?

Thanks,`,
      tactic: 'accusation_audit, precise_number, calibrated_question',
      reasoning: 'Standard opening with key tactics',
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
      reason: `Offer $${currentOffer.toLocaleString()} is at or below target price $${context.targetPrice.toLocaleString()}`,
    };
  }

  // Accept if close to target and we've been negotiating a while
  const exchangeCount = context.conversationHistory.length;
  if (currentOffer <= context.targetPrice * 1.05 && exchangeCount >= 4) {
    return {
      accept: true,
      reason: `Offer $${currentOffer.toLocaleString()} is within 5% of target after ${exchangeCount} exchanges`,
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
    reason: `Offer $${currentOffer.toLocaleString()} is above target $${context.targetPrice.toLocaleString()} - continue negotiating`,
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

  // Target: 15% below listed or market average, whichever is lower
  const baseTarget = marketAverage
    ? Math.min(listedPrice * 0.85, marketAverage * 0.95)
    : listedPrice * 0.85;

  // Ensure target is realistic (not below 70% of listed)
  const targetPrice = Math.max(baseTarget, listedPrice * 0.70);

  // Walk-away: budget minus estimated fees, or 5% below listed, whichever is lower
  const budgetBasedWalkAway = budget * 0.85; // Leave room for taxes/fees
  const listedBasedWalkAway = listedPrice * 0.95;
  const walkAwayPrice = Math.min(budgetBasedWalkAway, listedBasedWalkAway);

  return {
    targetPrice: Math.round(targetPrice),
    walkAwayPrice: Math.round(walkAwayPrice),
  };
}
