import type { Listing } from '../database/client.js';
import { getEnv } from '../config.js';

export type EmailTemplate =
  | 'initial_inquiry'
  | 'carfax_request'
  | 'follow_up'
  | 'price_inquiry'
  | 'schedule_viewing';

export interface TemplateContext {
  listing: Listing;
  buyerName?: string;
  buyerPhone?: string;
  customMessage?: string;
}

/**
 * Generate email content from a template
 */
export function generateEmail(
  template: EmailTemplate,
  context: TemplateContext
): { subject: string; text: string } {
  const buyerName = context.buyerName || getEnv('BUYER_NAME', false) || 'Interested Buyer';
  const buyerPhone = context.buyerPhone || getEnv('BUYER_PHONE', false) || '';

  const vehicle = `${context.listing.year} ${context.listing.make} ${context.listing.model}`;
  const price = context.listing.price ? `$${context.listing.price.toLocaleString()}` : 'listed price';

  const signature = `
Best regards,
${buyerName}${buyerPhone ? `\n${buyerPhone}` : ''}`;

  switch (template) {
    case 'initial_inquiry':
      return {
        subject: `Inquiry: ${vehicle}`,
        text: `Hello,

I'm interested in the ${vehicle} listed at ${price}.

I'm looking for a reliable family vehicle for long-term use. Could you please provide:

1. Is this vehicle still available?
2. Can you share the CARFAX or vehicle history report?
3. Are there any known issues or required repairs?
4. What is the vehicle's service history?

I'm a serious buyer and can arrange to view the vehicle at your convenience.

Thank you for your time.
${signature}`,
      };

    case 'carfax_request':
      return {
        subject: `CARFAX Request: ${vehicle}`,
        text: `Hello,

I'm interested in the ${vehicle} you have listed at ${price}.

Before scheduling a viewing, I would like to review the CARFAX or vehicle history report. Could you please send it to this email address?

Thank you.
${signature}`,
      };

    case 'follow_up':
      return {
        subject: `Following Up: ${vehicle}`,
        text: `Hello,

I'm following up on my inquiry about the ${vehicle} listed at ${price}.

Is this vehicle still available? I remain interested and would appreciate any updates.

Thank you.
${signature}`,
      };

    case 'price_inquiry':
      return {
        subject: `Price Inquiry: ${vehicle}`,
        text: `Hello,

Thank you for the information about the ${vehicle}.

I'm interested in this vehicle but wanted to discuss the price. Based on my research of comparable vehicles in the market, I was hoping we could discuss the asking price of ${price}.

${context.customMessage || 'Would you be open to discussing the price?'}

I'm a cash buyer and can complete the transaction quickly if we can reach an agreement.

Thank you.
${signature}`,
      };

    case 'schedule_viewing':
      return {
        subject: `Schedule Viewing: ${vehicle}`,
        text: `Hello,

I would like to schedule a time to view and test drive the ${vehicle}.

${context.customMessage || 'Please let me know what times work best for you.'}

I can be flexible with my schedule to accommodate yours.

Thank you.
${signature}`,
      };

    default:
      throw new Error(`Unknown template: ${template}`);
  }
}

/**
 * Generate a response to a dealer email using AI
 */
export async function generateAIResponse(
  incomingEmail: string,
  listing: Listing,
  context: string
): Promise<string> {
  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const { writeFileSync, unlinkSync } = await import('fs');
  const { tmpdir } = await import('os');
  const { join } = await import('path');

  const execAsync = promisify(exec);
  const buyerName = getEnv('BUYER_NAME', false) || 'Buyer';
  const vehicle = `${listing.year} ${listing.make} ${listing.model}`;

  const prompt = `You are helping a buyer respond to a car dealer's email. The buyer is looking for a reliable ${vehicle} for long-term family use.

VEHICLE:
${vehicle}
Price: $${listing.price?.toLocaleString() || 'Not listed'}
Mileage: ${listing.mileageKm?.toLocaleString() || 'Not listed'} km

CONTEXT:
${context}

DEALER'S EMAIL:
${incomingEmail}

Write a brief, professional response that:
1. Addresses any questions the dealer asked
2. Maintains interest but doesn't sound desperate
3. Asks about vehicle history/CARFAX if not yet received
4. Works toward scheduling a viewing if appropriate
5. Signs off as "${buyerName}"

Keep it concise - dealers are busy. Just the email body, no subject line.`;

  const promptFile = join(tmpdir(), `email-response-${Date.now()}.txt`);
  writeFileSync(promptFile, prompt);

  try {
    const { stdout } = await execAsync(
      `cat "${promptFile}" | claude --print --model haiku`,
      { timeout: 120000, maxBuffer: 1024 * 1024 }
    );
    return stdout.trim();
  } catch (error) {
    // Fallback response if AI fails
    return `Thank you for your response regarding the ${vehicle}. I remain interested and would like to proceed with scheduling a viewing at your earliest convenience.\n\nBest regards,\n${buyerName}`;
  } finally {
    try {
      unlinkSync(promptFile);
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Detect if an email contains a CARFAX attachment
 */
export function hasCarfaxAttachment(attachments: Array<{ filename: string; contentType: string }>): boolean {
  return attachments.some(
    att =>
      att.contentType === 'application/pdf' &&
      (att.filename.toLowerCase().includes('carfax') ||
       att.filename.toLowerCase().includes('history') ||
       att.filename.toLowerCase().includes('report'))
  );
}

/**
 * Extract dealer email from listing or description
 */
export function extractDealerEmail(listing: Listing): string | null {
  // Check if we have it stored
  if (listing.sellerEmail) {
    return listing.sellerEmail;
  }

  // Try to extract from description
  if (listing.description) {
    const emailMatch = listing.description.match(
      /[\w.-]+@[\w.-]+\.\w{2,}/
    );
    if (emailMatch) {
      return emailMatch[0];
    }
  }

  return null;
}

/**
 * Extract dealer phone from listing or description
 */
export function extractDealerPhone(listing: Listing): string | null {
  if (listing.sellerPhone) {
    return listing.sellerPhone;
  }

  if (listing.description) {
    // Match various phone formats
    const phoneMatch = listing.description.match(
      /(?:\+?1[-.\s]?)?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}/
    );
    if (phoneMatch) {
      return phoneMatch[0];
    }
  }

  return null;
}
