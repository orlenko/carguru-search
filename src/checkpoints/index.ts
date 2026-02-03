/**
 * Checkpoint system for human approval of automated actions
 */
import { getDatabase } from '../database/index.js';
import { getCheckpointsConfig, type CheckpointsConfig } from '../config.js';

export type CheckpointType =
  | 'offer_threshold'
  | 'viewing_approval'
  | 'max_followups'
  | 'portfolio_exposure'
  | 'unusual_behavior';

export interface CheckpointResult {
  requiresApproval: boolean;
  approvalId?: number;
  reason?: string;
}

/**
 * Check if an offer requires approval based on amount
 */
export function checkOfferApproval(
  listingId: number,
  offerAmount: number,
  payload: Record<string, unknown>
): CheckpointResult {
  const config = getCheckpointsConfig();
  const db = getDatabase();

  if (!config.enabled) {
    return { requiresApproval: false };
  }

  if (offerAmount >= config.offerApprovalThreshold) {
    const listing = db.getListing(listingId);
    const vehicle = listing
      ? `${listing.year} ${listing.make} ${listing.model}`
      : `Listing #${listingId}`;

    const approvalId = db.queueForApproval({
      listingId,
      actionType: 'send_offer',
      description: `Send offer of $${offerAmount.toLocaleString()} for ${vehicle}`,
      reasoning: `Offer amount ($${offerAmount.toLocaleString()}) exceeds approval threshold ($${config.offerApprovalThreshold.toLocaleString()})`,
      payload: { ...payload, offerAmount },
      checkpointType: 'offer_threshold',
      thresholdValue: `$${config.offerApprovalThreshold.toLocaleString()}`,
    });

    return {
      requiresApproval: true,
      approvalId,
      reason: `Offer of $${offerAmount.toLocaleString()} exceeds threshold of $${config.offerApprovalThreshold.toLocaleString()}`,
    };
  }

  return { requiresApproval: false };
}

/**
 * Check if scheduling a viewing requires approval
 */
export function checkViewingApproval(
  listingId: number,
  viewingDetails: {
    date: string;
    time?: string;
    location?: string;
    sellerName?: string;
  },
  payload: Record<string, unknown>
): CheckpointResult {
  const config = getCheckpointsConfig();
  const db = getDatabase();

  if (!config.enabled || !config.viewingRequiresApproval) {
    return { requiresApproval: false };
  }

  const listing = db.getListing(listingId);
  const vehicle = listing
    ? `${listing.year} ${listing.make} ${listing.model}`
    : `Listing #${listingId}`;

  const description = `Schedule viewing for ${vehicle} on ${viewingDetails.date}${
    viewingDetails.time ? ` at ${viewingDetails.time}` : ''
  }${viewingDetails.location ? ` at ${viewingDetails.location}` : ''}`;

  const approvalId = db.queueForApproval({
    listingId,
    actionType: 'schedule_viewing',
    description,
    reasoning: 'Viewing requires human approval per configuration',
    payload: { ...payload, viewingDetails },
    checkpointType: 'viewing_approval',
  });

  return {
    requiresApproval: true,
    approvalId,
    reason: 'Viewing scheduling requires approval',
  };
}

/**
 * Check if a follow-up email should be sent or if max reached
 */
export function checkFollowUpApproval(
  listingId: number,
  followUpCount: number,
  payload: Record<string, unknown>
): CheckpointResult {
  const config = getCheckpointsConfig();
  const db = getDatabase();

  if (!config.enabled) {
    return { requiresApproval: false };
  }

  if (followUpCount >= config.maxAutoFollowups) {
    const listing = db.getListing(listingId);
    const vehicle = listing
      ? `${listing.year} ${listing.make} ${listing.model}`
      : `Listing #${listingId}`;

    const approvalId = db.queueForApproval({
      listingId,
      actionType: 'follow_up',
      description: `Send follow-up #${followUpCount + 1} for ${vehicle}`,
      reasoning: `Reached max auto follow-ups (${config.maxAutoFollowups}). Human decision required to continue.`,
      payload: { ...payload, followUpCount: followUpCount + 1 },
      checkpointType: 'max_followups',
      thresholdValue: `${config.maxAutoFollowups}`,
    });

    return {
      requiresApproval: true,
      approvalId,
      reason: `Max auto follow-ups (${config.maxAutoFollowups}) reached`,
    };
  }

  return { requiresApproval: false };
}

/**
 * Check portfolio exposure (total potential spend across all active deals)
 */
export function checkPortfolioExposure(
  newDealAmount: number,
  payload: Record<string, unknown>
): CheckpointResult {
  const config = getCheckpointsConfig();
  const db = getDatabase();

  if (!config.enabled || !config.portfolioExposureAlert) {
    return { requiresApproval: false };
  }

  // Calculate total exposure from active negotiations
  const activeListings = db.listListings({
    status: ['negotiating', 'viewing_scheduled', 'offer_made'] as any,
    limit: 100,
  });

  let totalExposure = newDealAmount;
  for (const listing of activeListings) {
    const cost = db.getCostBreakdown(listing.id);
    if (cost?.totalEstimatedCost) {
      totalExposure += cost.totalEstimatedCost;
    } else if (listing.price) {
      totalExposure += listing.price;
    }
  }

  if (totalExposure > config.portfolioExposureAlert) {
    const approvalId = db.queueForApproval({
      actionType: 'portfolio_exposure',
      description: `Total portfolio exposure ($${totalExposure.toLocaleString()}) exceeds alert threshold`,
      reasoning: `Adding this deal would bring total exposure to $${totalExposure.toLocaleString()}, exceeding the $${config.portfolioExposureAlert.toLocaleString()} threshold`,
      payload: {
        ...payload,
        totalExposure,
        threshold: config.portfolioExposureAlert,
        activeDeals: activeListings.length,
      },
      checkpointType: 'portfolio_exposure',
      thresholdValue: `$${config.portfolioExposureAlert.toLocaleString()}`,
    });

    return {
      requiresApproval: true,
      approvalId,
      reason: `Portfolio exposure ($${totalExposure.toLocaleString()}) exceeds threshold`,
    };
  }

  return { requiresApproval: false };
}

/**
 * Queue an action for approval due to unusual seller behavior
 */
export function flagUnusualBehavior(
  listingId: number,
  behaviorDescription: string,
  payload: Record<string, unknown>
): CheckpointResult {
  const config = getCheckpointsConfig();
  const db = getDatabase();

  if (!config.enabled) {
    return { requiresApproval: false };
  }

  const listing = db.getListing(listingId);
  const vehicle = listing
    ? `${listing.year} ${listing.make} ${listing.model}`
    : `Listing #${listingId}`;

  const approvalId = db.queueForApproval({
    listingId,
    actionType: 'unusual_behavior',
    description: `Unusual seller behavior detected for ${vehicle}`,
    reasoning: behaviorDescription,
    payload,
    checkpointType: 'unusual_behavior',
  });

  return {
    requiresApproval: true,
    approvalId,
    reason: behaviorDescription,
  };
}

/**
 * Check if checkpoints are enabled globally
 */
export function areCheckpointsEnabled(): boolean {
  const config = getCheckpointsConfig();
  return config.enabled;
}

/**
 * Get the checkpoints configuration
 */
export function getCheckpoints(): CheckpointsConfig {
  return getCheckpointsConfig();
}
