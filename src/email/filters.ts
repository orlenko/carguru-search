/**
 * Email filtering utilities - shared across all email processing commands
 */

export interface EmailFilterInput {
  from: string;
  subject: string;
  text: string;
}

export interface SkipResult {
  skip: boolean;
  reason: string;
}

function isAutoTraderLead(email: EmailFilterInput): boolean {
  const fromLower = email.from.toLowerCase();
  const subjectLower = email.subject.toLowerCase();
  const textLower = email.text.toLowerCase();

  const fromTrader = fromLower.includes('@trader.ca') || fromLower.includes('@autotrader.ca');
  const subjectLead = subjectLower.includes('lead') ||
    subjectLower.includes('autotrader') ||
    subjectLower.includes('used trader lead') ||
    subjectLower.includes('sales lead');
  const textLead = textLower.includes('autotrader') && textLower.includes('lead');

  return (fromTrader && subjectLead) || subjectLead || textLead;
}

/**
 * Check if an email should be skipped (automated, noreply, marketing, etc.)
 * Used by: smart-respond, pipeline, outreach, negotiate, email-followup
 */
export function shouldSkipEmail(email: EmailFilterInput): SkipResult {
  const fromLower = email.from.toLowerCase();
  const subjectLower = email.subject.toLowerCase();

  if (isAutoTraderLead(email)) {
    return { skip: false, reason: '' };
  }

  // Skip noreply addresses
  if (fromLower.includes('noreply') || fromLower.includes('no-reply') || fromLower.includes('donotreply')) {
    return { skip: true, reason: 'noreply address' };
  }

  // Skip automated/system addresses
  const automatedPatterns = [
    'mailer-daemon',
    'postmaster',
    'autoresponder',
    'auto-reply',
    'automated',
    'notification@',
    'notifications@',
    'alert@',
    'alerts@',
    'system@',
    'admin@',
    'support@',  // Usually automated ticket systems
  ];
  for (const pattern of automatedPatterns) {
    if (fromLower.includes(pattern)) {
      return { skip: true, reason: `automated address (${pattern})` };
    }
  }

  // Skip marketing/newsletter subjects
  const marketingSubjects = [
    'subscription confirmed',
    "you're subscribed",
    'welcome to',
    'thank you for signing up',
    'price alert',
    'price drop',
    'similar vehicles',
    'new listings',
    'unsubscribe',
    'weekly digest',
    'daily digest',
    'newsletter',
  ];
  for (const pattern of marketingSubjects) {
    if (subjectLower.includes(pattern)) {
      return { skip: true, reason: `marketing email (${pattern})` };
    }
  }

  // Skip obvious confirmation emails (but not viewing confirmations)
  if (subjectLower.includes('confirmation') && !subjectLower.includes('viewing')) {
    return { skip: true, reason: 'confirmation email' };
  }

  return { skip: false, reason: '' };
}
