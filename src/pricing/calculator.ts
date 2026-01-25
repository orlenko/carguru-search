/**
 * Ontario vehicle purchase cost calculator
 */

export interface PricingAnalysis {
  advertisedPrice: number;
  pricingType: 'all-in' | 'plus-tax' | 'plus-fees' | 'unclear';
  mentionedFees: Array<{ name: string; amount: number | null }>;
  certificationStatus: 'certified' | 'as-is' | 'unclear';
  certificationCost: number | null;
  warrantyIncluded: boolean;
  warrantyDetails: string | null;
}

export interface DeceptionFlags {
  deceptiveLanguage: string[];
  hiddenCosts: string[];
  missingInfo: string[];
}

export interface CostBreakdown {
  listedPrice: number;
  hst: number;
  licensing: number;
  omvicFee: number;
  estimatedDealerFees: number;
  estimatedCertification: number;
  totalCost: number;
  isEstimated: boolean;
  warnings: string[];
  withinBudget: boolean;
  overBudgetBy: number;
}

// Ontario constants
const HST_RATE = 0.13;
const REGISTRATION_FEE = 32;
const PLATE_STICKER_FEE = 120; // ~$120/year for Southern Ontario
const OMVIC_FEE = 10;
const TYPICAL_DEALER_ADMIN_FEE = 499;
const TYPICAL_CERTIFICATION_COST = 800;

/**
 * Calculate total purchase cost for Ontario
 */
export function calculateTotalCost(
  listedPrice: number,
  pricing: Partial<PricingAnalysis> | null,
  budget: number,
  isDealer: boolean
): CostBreakdown {
  const warnings: string[] = [];
  let estimatedDealerFees = 0;
  let estimatedCertification = 0;
  let isEstimated = false;

  // Base price
  let basePrice = listedPrice;

  // Handle pricing type
  const pricingType = pricing?.pricingType || 'unclear';

  if (pricingType === 'unclear') {
    warnings.push('Pricing type unclear - assuming plus tax/fees');
    isEstimated = true;
  }

  // Calculate HST (always applies in Ontario)
  // For all-in pricing, HST is included; otherwise add it
  let hst = 0;
  if (pricingType !== 'all-in') {
    hst = Math.round(basePrice * HST_RATE);
  }

  // Licensing fees (registration + plate)
  const licensing = REGISTRATION_FEE + PLATE_STICKER_FEE;

  // OMVIC fee (dealer sales only)
  const omvicFee = isDealer ? OMVIC_FEE : 0;

  // Dealer fees
  if (isDealer) {
    if (pricing?.mentionedFees && pricing.mentionedFees.length > 0) {
      // Use mentioned fees
      for (const fee of pricing.mentionedFees) {
        if (fee.amount !== null) {
          estimatedDealerFees += fee.amount;
        } else {
          // Fee mentioned but no amount - estimate
          estimatedDealerFees += 200;
          warnings.push(`"${fee.name}" mentioned without amount - estimated $200`);
          isEstimated = true;
        }
      }
    } else if (pricingType !== 'all-in') {
      // No fees mentioned, dealer sale, not all-in - assume typical admin fee
      estimatedDealerFees = TYPICAL_DEALER_ADMIN_FEE;
      warnings.push('No fees mentioned - estimated typical dealer admin fee ($499)');
      isEstimated = true;
    }
  }

  // Certification
  const certStatus = pricing?.certificationStatus || 'unclear';
  if (certStatus === 'as-is') {
    estimatedCertification = TYPICAL_CERTIFICATION_COST;
    warnings.push('Sold as-is - budget for safety certification (~$800)');
  } else if (certStatus === 'unclear') {
    if (isDealer) {
      // OMVIC requires dealers to disclose - unclear is suspicious
      warnings.push('Certification status not stated (OMVIC requires disclosure)');
      estimatedCertification = TYPICAL_CERTIFICATION_COST / 2; // 50% chance
      isEstimated = true;
    } else {
      // Private sale - assume as-is
      estimatedCertification = TYPICAL_CERTIFICATION_COST;
      warnings.push('Private sale - assume as-is, budget for certification');
    }
  } else if (certStatus === 'certified' && pricing?.certificationCost) {
    // Certification included but costs extra
    estimatedCertification = pricing.certificationCost;
    warnings.push(`Certification costs extra: $${pricing.certificationCost}`);
  }
  // If certified and no extra cost, estimatedCertification stays 0

  // Total
  const totalCost = basePrice + hst + licensing + omvicFee + estimatedDealerFees + estimatedCertification;
  const withinBudget = totalCost <= budget;
  const overBudgetBy = withinBudget ? 0 : totalCost - budget;

  return {
    listedPrice,
    hst,
    licensing,
    omvicFee,
    estimatedDealerFees,
    estimatedCertification,
    totalCost,
    isEstimated,
    warnings,
    withinBudget,
    overBudgetBy,
  };
}

/**
 * Format cost breakdown for display
 */
export function formatCostBreakdown(breakdown: CostBreakdown, budget: number): string {
  const lines: string[] = [];

  lines.push(`Listed price:     $${breakdown.listedPrice.toLocaleString()}`);

  if (breakdown.hst > 0) {
    lines.push(`+ HST (13%):      $${breakdown.hst.toLocaleString()}`);
  }

  lines.push(`+ Licensing:      $${breakdown.licensing.toLocaleString()}`);

  if (breakdown.omvicFee > 0) {
    lines.push(`+ OMVIC fee:      $${breakdown.omvicFee.toLocaleString()}`);
  }

  if (breakdown.estimatedDealerFees > 0) {
    const est = breakdown.isEstimated ? ' (est.)' : '';
    lines.push(`+ Dealer fees:    $${breakdown.estimatedDealerFees.toLocaleString()}${est}`);
  }

  if (breakdown.estimatedCertification > 0) {
    lines.push(`+ Certification:  $${breakdown.estimatedCertification.toLocaleString()} (est.)`);
  }

  lines.push('─'.repeat(30));

  const estLabel = breakdown.isEstimated ? ' (estimated)' : '';
  lines.push(`TOTAL:            $${breakdown.totalCost.toLocaleString()}${estLabel}`);

  if (!breakdown.withinBudget) {
    lines.push(`\n⚠️  OVER BUDGET by $${breakdown.overBudgetBy.toLocaleString()} (budget: $${budget.toLocaleString()})`);
  } else {
    const remaining = budget - breakdown.totalCost;
    lines.push(`\n✅ Within budget ($${remaining.toLocaleString()} remaining)`);
  }

  if (breakdown.warnings.length > 0) {
    lines.push('\n⚠️  Notes:');
    for (const warning of breakdown.warnings) {
      lines.push(`   • ${warning}`);
    }
  }

  return lines.join('\n');
}

/**
 * Grand Caravan trim levels ranked by desirability
 */
export const TRIM_LEVELS: Record<string, { rank: number; name: string; features: string }> = {
  'cvp': { rank: 1, name: 'Canada Value Package', features: 'Base model' },
  'canada value package': { rank: 1, name: 'Canada Value Package', features: 'Base model' },
  'avp': { rank: 1, name: 'American Value Package', features: 'Base model (US)' },
  'se': { rank: 2, name: 'SE', features: 'More features than base' },
  'se plus': { rank: 3, name: 'SE Plus', features: 'Enhanced SE' },
  'sxt': { rank: 4, name: 'SXT', features: "Stow'n'Go seats, power options" },
  'sxt plus': { rank: 5, name: 'SXT Plus', features: "Enhanced SXT, Stow'n'Go" },
  'crew': { rank: 6, name: 'Crew', features: 'Leather, premium features' },
  'crew plus': { rank: 7, name: 'Crew Plus', features: 'Enhanced Crew' },
  'gt': { rank: 8, name: 'GT', features: 'Sport appearance, leather' },
  'r/t': { rank: 9, name: 'R/T', features: 'Premium, sport, navigation' },
};

/**
 * Parse trim level from listing title/description
 */
export function parseTrimLevel(title: string, description?: string): { trim: string; rank: number } | null {
  const text = `${title} ${description || ''}`.toLowerCase();

  // Check for each trim level
  for (const [key, info] of Object.entries(TRIM_LEVELS)) {
    // Look for trim as whole word
    const regex = new RegExp(`\\b${key.replace(/[+/]/g, '\\$&')}\\b`, 'i');
    if (regex.test(text)) {
      return { trim: info.name, rank: info.rank };
    }
  }

  // Special cases
  if (text.includes("stow'n'go") || text.includes('stow n go') || text.includes('stow and go')) {
    // Has Stow'n'Go - at least SXT level
    return { trim: 'SXT (inferred from Stow\'n\'Go)', rank: 4 };
  }

  if (text.includes('leather')) {
    // Has leather - likely Crew or higher
    return { trim: 'Crew+ (inferred from leather)', rank: 6 };
  }

  return null;
}

/**
 * Get trim bonus points for scoring
 */
export function getTrimBonus(trimRank: number): number {
  // Base (CVP) = 0 bonus, top trim (R/T) = 10 bonus
  return Math.min(10, (trimRank - 1) * 1.25);
}
