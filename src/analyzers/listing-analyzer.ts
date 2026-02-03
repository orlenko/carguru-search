import fs from 'fs';
import path from 'path';
import type { Listing } from '../database/client.js';
import { runClaudeTask } from '../claude/task-runner.js';
import { syncListingToWorkspace, writeSearchContext } from '../workspace/index.js';

const CLAUDE_SENTINEL = 'task complete';

export interface ListingAnalysis {
  redFlags: string[];
  positives: string[];
  concerns: string[];
  estimatedCondition: 'excellent' | 'good' | 'fair' | 'poor' | 'unknown';
  recommendationScore: number; // 0-100
  summary: string;
  // Pricing analysis (added)
  pricing?: {
    pricingType: 'all-in' | 'plus-tax' | 'plus-fees' | 'unclear';
    mentionedFees: Array<{ name: string; amount: number | null }>;
    certificationStatus: 'certified' | 'as-is' | 'unclear';
    certificationCost: number | null;
  };
  // Deception detection (added)
  deception?: {
    deceptiveLanguage: string[];
    hiddenCosts: string[];
    missingInfo: string[];
  };
  // Trim level (added)
  detectedTrim?: string;
}

const ANALYSIS_PROMPT = `You are an expert used car buyer assistant analyzing a listing for someone in Ontario, Canada looking for a reliable Dodge Grand Caravan for long-term family use. They will keep it until it dies - resale value doesn't matter.

Analyze the listing for quality AND extract pricing/fee information. Detect any deceptive language or hidden costs.

Respond ONLY with a JSON object (no markdown, no explanation):
{
  "redFlags": ["list of red flags - commercial/fleet use, accident signs, salvage, suspicious pricing, high mileage for year, as-is language"],
  "positives": ["list of positive signs - single owner, clean history, maintenance, low mileage"],
  "concerns": ["things to verify with dealer but not dealbreakers"],
  "estimatedCondition": "excellent|good|fair|poor|unknown",
  "recommendationScore": 0-100,
  "summary": "2-3 sentence assessment",
  "pricing": {
    "pricingType": "all-in|plus-tax|plus-fees|unclear",
    "mentionedFees": [{"name": "fee name", "amount": 499}],
    "certificationStatus": "certified|as-is|unclear",
    "certificationCost": null
  },
  "deception": {
    "deceptiveLanguage": ["suspicious phrases like 'price doesn't include...' buried in text, unrealistic claims"],
    "hiddenCosts": ["potential hidden costs - e.g., 'plus fees' mentioned casually"],
    "missingInfo": ["important missing info - no accident disclosure, no service history mentioned, etc."]
  },
  "detectedTrim": "CVP|SE|SXT|SXT Plus|Crew|GT|R/T or null if unclear"
}

PRICING GUIDE:
- "all-in" = price includes everything (tax, fees, certification)
- "plus-tax" = price + HST, but fees/cert included
- "plus-fees" = price + HST + dealer fees + possibly certification
- "unclear" = not explicitly stated (assume plus-fees for dealers)

CERTIFICATION (Ontario OMVIC rules):
- Dealers MUST disclose if vehicle is "as-is" or "certified"
- If dealer doesn't mention certification status, flag as suspicious
- "Safety certified" or "Certified" = passes Ontario safety standards
- "As-is" = buyer responsible for repairs and certification

DECEPTION PATTERNS TO DETECT:
- Price that seems too good to be true
- "Call for price" or "Contact for best price" games
- Fees mentioned only in fine print
- "Great condition" without evidence
- Vague mileage or history descriptions
- Missing accident disclosure on older vehicles

Score guide: 80+: strong candidate, 60-79: decent, 40-59: caution, 0-39: avoid

LISTING:
`;

/**
 * Analyze a listing using Claude CLI subprocess
 * Uses a temp file to avoid shell escaping issues
 */
export async function analyzeListingWithClaude(listing: Listing): Promise<ListingAnalysis> {
  const listingInfo = formatListingForAnalysis(listing);
  const prompt = ANALYSIS_PROMPT + listingInfo;

  writeSearchContext();
  const listingDir = syncListingToWorkspace(listing);
  const taskDir = path.join(listingDir, 'claude', `listing-analysis-${Date.now()}`);
  fs.mkdirSync(taskDir, { recursive: true });
  const taskFile = path.join(taskDir, 'task.md');
  const resultFile = path.join(taskDir, 'result.json');
  const resultRel = path.relative(listingDir, resultFile);

  const taskBody = `${prompt}

---

Write ONLY the JSON to: ${resultRel}

After writing the file, output this line exactly:
${CLAUDE_SENTINEL}
`;
  fs.writeFileSync(taskFile, taskBody);

  await runClaudeTask({
    workspaceDir: listingDir,
    taskFile: path.relative(listingDir, taskFile),
    resultFile: resultRel,
    model: process.env.CLAUDE_MODEL_LISTING || process.env.CLAUDE_MODEL || undefined,
    dangerous: process.env.CLAUDE_DANGEROUS !== 'false',
    timeoutMs: 120000,
    sentinel: CLAUDE_SENTINEL,
  });

  if (!fs.existsSync(resultFile)) {
    throw new Error('Claude did not write a result file');
  }

  const raw = fs.readFileSync(resultFile, 'utf-8');
  let jsonStr = raw.trim();

  // Remove markdown code blocks if present
  const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1].trim();
  }

  const objMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (!objMatch) {
    throw new Error(`No JSON found in response: ${raw.slice(0, 200)}`);
  }

  const analysis = JSON.parse(objMatch[0]) as ListingAnalysis;

  // Validate required fields
  if (typeof analysis.recommendationScore !== 'number') {
    analysis.recommendationScore = 50;
  }
  if (!analysis.estimatedCondition) {
    analysis.estimatedCondition = 'unknown';
  }
  if (!Array.isArray(analysis.redFlags)) {
    analysis.redFlags = [];
  }
  if (!Array.isArray(analysis.positives)) {
    analysis.positives = [];
  }
  if (!Array.isArray(analysis.concerns)) {
    analysis.concerns = [];
  }

  return analysis;
}

function formatListingForAnalysis(listing: Listing): string {
  const parts: string[] = [];

  parts.push(`Vehicle: ${listing.year} ${listing.make} ${listing.model}${listing.trim ? ` ${listing.trim}` : ''}`);
  parts.push(`Price: $${listing.price?.toLocaleString() || 'Not listed'}`);
  parts.push(`Mileage: ${listing.mileageKm?.toLocaleString() || 'Not listed'} km`);
  parts.push(`Location: ${listing.city || 'Unknown'}${listing.province ? `, ${listing.province}` : ''}`);

  if (listing.sellerName) {
    parts.push(`Seller: ${listing.sellerName} (${listing.sellerType || 'unknown type'})`);
  }

  if (listing.distanceKm) {
    parts.push(`Distance: ${listing.distanceKm} km from buyer`);
  }

  if (listing.description) {
    parts.push(`\nDescription:\n${listing.description}`);
  }

  // Calculate mileage per year for context
  const currentYear = new Date().getFullYear();
  const vehicleAge = currentYear - listing.year;
  if (listing.mileageKm && vehicleAge > 0) {
    const avgMileagePerYear = Math.round(listing.mileageKm / vehicleAge);
    parts.push(`\n(Calculated: ~${avgMileagePerYear.toLocaleString()} km/year average, typical is 15,000-20,000 km/year)`);
  }

  return parts.join('\n');
}

/**
 * Legacy class for API-based analysis (kept for compatibility)
 */
export class ListingAnalyzer {
  async analyzeListing(listing: Listing): Promise<ListingAnalysis> {
    return analyzeListingWithClaude(listing);
  }
}

/**
 * Batch analyze multiple listings with progress callback
 */
export async function batchAnalyzeListings(
  listings: Listing[],
  onProgress?: (completed: number, total: number, listing: Listing) => void
): Promise<Map<number, ListingAnalysis>> {
  const results = new Map<number, ListingAnalysis>();

  for (let i = 0; i < listings.length; i++) {
    const listing = listings[i];

    if (onProgress) {
      onProgress(i, listings.length, listing);
    }

    try {
      const analysis = await analyzeListingWithClaude(listing);
      results.set(listing.id, analysis);
    } catch (error) {
      console.error(`  Failed to analyze listing ${listing.id}:`, error);
    }

    // Small delay between requests to be nice
    if (i < listings.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  return results;
}
