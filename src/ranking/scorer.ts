import type { Listing } from '../database/client.js';
import type { ScoringConfig } from '../config.js';
import type { ListingAnalysis } from '../analyzers/listing-analyzer.js';

export interface ScoringResult {
  totalScore: number;
  breakdown: {
    price: number;
    mileage: number;
    aiRecommendation: number;
    condition: number;
    distance: number;
  };
  dealBreakers: string[];
  passed: boolean;
}

// Reference values for scoring (adjust based on market)
const REFERENCE = {
  idealPrice: 12000,      // Best price in CAD
  maxPrice: 20000,        // Max acceptable
  idealMileage: 50000,    // Best mileage in km
  maxMileage: 150000,     // Max acceptable
  idealDistance: 0,       // Best distance
  maxDistance: 300,       // Max acceptable distance in km
};

export class ListingScorer {
  private config: ScoringConfig;

  constructor(config: ScoringConfig) {
    this.config = config;
  }

  /**
   * Score a listing based on available data
   */
  scoreListing(listing: Listing, analysis?: ListingAnalysis): ScoringResult {
    const dealBreakers = this.checkDealBreakers(listing, analysis);

    if (dealBreakers.length > 0) {
      return {
        totalScore: 0,
        breakdown: { price: 0, mileage: 0, aiRecommendation: 0, condition: 0, distance: 0 },
        dealBreakers,
        passed: false,
      };
    }

    const breakdown = {
      price: this.scorePrice(listing.price),
      mileage: this.scoreMileage(listing.mileageKm),
      aiRecommendation: analysis?.recommendationScore ?? 50,
      condition: this.scoreCondition(analysis?.estimatedCondition),
      distance: this.scoreDistance(listing.distanceKm),
    };

    // Weighted average
    const weights = this.config.weights;
    const totalScore = Math.round(
      breakdown.price * weights.price +
      breakdown.mileage * weights.mileage +
      breakdown.aiRecommendation * weights.accidentHistory + // Using AI score for this
      breakdown.condition * weights.serviceRecords +
      breakdown.distance * weights.dealerRating // Repurposing for distance
    );

    return {
      totalScore: Math.min(100, Math.max(0, totalScore)),
      breakdown,
      dealBreakers: [],
      passed: true,
    };
  }

  private scorePrice(price: number | null): number {
    if (!price) return 50; // Unknown, neutral score

    if (price <= REFERENCE.idealPrice) return 100;
    if (price >= REFERENCE.maxPrice) return 0;

    // Linear interpolation
    const range = REFERENCE.maxPrice - REFERENCE.idealPrice;
    const diff = price - REFERENCE.idealPrice;
    return Math.round(100 * (1 - diff / range));
  }

  private scoreMileage(mileage: number | null): number {
    if (!mileage) return 50;

    if (mileage <= REFERENCE.idealMileage) return 100;
    if (mileage >= REFERENCE.maxMileage) return 0;

    const range = REFERENCE.maxMileage - REFERENCE.idealMileage;
    const diff = mileage - REFERENCE.idealMileage;
    return Math.round(100 * (1 - diff / range));
  }

  private scoreDistance(distance: number | null | undefined): number {
    if (!distance) return 70; // Unknown, slightly positive

    if (distance <= 50) return 100;
    if (distance >= REFERENCE.maxDistance) return 30;

    const range = REFERENCE.maxDistance - 50;
    const diff = distance - 50;
    return Math.round(100 * (1 - diff / range) * 0.7 + 30);
  }

  private scoreCondition(condition: string | undefined): number {
    const scores: Record<string, number> = {
      excellent: 100,
      good: 80,
      fair: 50,
      poor: 20,
      unknown: 50,
    };
    return scores[condition || 'unknown'] ?? 50;
  }

  private checkDealBreakers(listing: Listing, analysis?: ListingAnalysis): string[] {
    const dealBreakers: string[] = [];
    const configBreakers = this.config.dealBreakers || [];

    // Check red flags from AI analysis
    if (analysis?.redFlags) {
      for (const flag of analysis.redFlags) {
        const flagLower = flag.toLowerCase();

        if (configBreakers.includes('salvageTitle') &&
            (flagLower.includes('salvage') || flagLower.includes('rebuilt'))) {
          dealBreakers.push(`Salvage/rebuilt title: ${flag}`);
        }

        if (configBreakers.includes('frameDamage') &&
            flagLower.includes('frame')) {
          dealBreakers.push(`Frame damage: ${flag}`);
        }

        if (configBreakers.includes('floodDamage') &&
            flagLower.includes('flood')) {
          dealBreakers.push(`Flood damage: ${flag}`);
        }

        if (configBreakers.includes('commercialUse') &&
            (flagLower.includes('taxi') || flagLower.includes('fleet') ||
             flagLower.includes('rental') || flagLower.includes('commercial'))) {
          dealBreakers.push(`Commercial use: ${flag}`);
        }
      }
    }

    // Check description for deal breakers
    const desc = (listing.description || '').toLowerCase();

    if (configBreakers.includes('salvageTitle') &&
        (desc.includes('salvage') || desc.includes('rebuilt title'))) {
      dealBreakers.push('Description mentions salvage/rebuilt title');
    }

    if (configBreakers.includes('commercialUse') &&
        (desc.includes('ex-taxi') || desc.includes('former taxi') ||
         desc.includes('ex-rental') || desc.includes('fleet vehicle'))) {
      dealBreakers.push('Description indicates commercial/fleet use');
    }

    return dealBreakers;
  }
}

/**
 * Rank listings by score
 */
export function rankListings(
  listings: Listing[],
  analyses: Map<number, ListingAnalysis>,
  config: ScoringConfig
): Array<{ listing: Listing; score: ScoringResult }> {
  const scorer = new ListingScorer(config);

  const scored = listings.map(listing => ({
    listing,
    score: scorer.scoreListing(listing, analyses.get(listing.id)),
  }));

  // Sort by total score descending, then by price ascending
  scored.sort((a, b) => {
    if (b.score.totalScore !== a.score.totalScore) {
      return b.score.totalScore - a.score.totalScore;
    }
    return (a.listing.price || 0) - (b.listing.price || 0);
  });

  return scored;
}
