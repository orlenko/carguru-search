import fs from 'fs';
import path from 'path';
import type { Listing, ConversationMessage } from '../database/client.js';
import { loadConfig, type Config } from '../config.js';

export const WORKSPACE_DIR = 'workspace';
export const LISTINGS_DIR = path.join(WORKSPACE_DIR, 'listings');
export const SEARCH_CONTEXT_FILE = path.join(WORKSPACE_DIR, 'search.json');

export function ensureWorkspaceRoot(): void {
  fs.mkdirSync(LISTINGS_DIR, { recursive: true });
}

export function writeSearchContext(config?: Config): void {
  const resolvedConfig = config ?? loadConfig();
  ensureWorkspaceRoot();

  const payload = {
    generatedAt: new Date().toISOString(),
    search: resolvedConfig.search,
    scoring: resolvedConfig.scoring,
    checkpoints: resolvedConfig.checkpoints,
    privateNotes: resolvedConfig.privateNotes ?? null,
  };

  fs.writeFileSync(SEARCH_CONTEXT_FILE, JSON.stringify(payload, null, 2));
}

export function getListingDirName(listing: { id: number; year: number; make: string; model: string }): string {
  const slug = `${listing.year}-${listing.make}-${listing.model}`
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
  return `${String(listing.id).padStart(3, '0')}-${slug}`;
}

export function getListingWorkspaceDir(listing: { id: number; year: number; make: string; model: string }): string {
  return path.join(LISTINGS_DIR, getListingDirName(listing));
}

function copyDirectory(srcDir: string, destDir: string): void {
  if (!fs.existsSync(srcDir)) return;
  fs.mkdirSync(destDir, { recursive: true });
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);

    if (entry.isDirectory()) {
      copyDirectory(srcPath, destPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function writeConversationHistory(
  emailsDir: string,
  messages: ConversationMessage[]
): void {
  fs.mkdirSync(emailsDir, { recursive: true });

  let emailNum = 1;
  for (const msg of messages) {
    const direction = msg.direction || 'inbound';
    const date = msg.date || new Date().toISOString();
    const dateStr = date.split('T')[0];
    const filename = `${String(emailNum).padStart(2, '0')}-${direction}-${dateStr}.md`;

    const emailMd = `# ${direction === 'outbound' ? 'Sent' : 'Received'}: ${date}

**Channel:** ${msg.channel}
${msg.subject ? `**Subject:** ${msg.subject}` : ''}

---

${msg.body || 'No content'}
`;
    fs.writeFileSync(path.join(emailsDir, filename), emailMd);
    emailNum++;
  }
}

export function syncListingToWorkspace(listing: Listing): string {
  ensureWorkspaceRoot();

  const listingDir = getListingWorkspaceDir(listing);
  const emailsDir = path.join(listingDir, 'emails');
  const attachmentsDir = path.join(listingDir, 'attachments');

  fs.mkdirSync(emailsDir, { recursive: true });
  fs.mkdirSync(attachmentsDir, { recursive: true });

  // Full JSON snapshot for Claude reference
  fs.writeFileSync(path.join(listingDir, 'listing.json'), JSON.stringify(listing, null, 2));

  // Human-readable summary
  const specs = listing.specs || {};
  const listingMd = `# ${listing.year} ${listing.make} ${listing.model}

## Vehicle Details

| Field | Value |
|-------|-------|
| **Price** | $${listing.price?.toLocaleString() || 'N/A'} |
| **Mileage** | ${listing.mileageKm?.toLocaleString() || 'N/A'} km |
| **VIN** | ${listing.vin || 'Not available'} |
| **Status** | ${listing.status} |
| **Info Status** | ${listing.infoStatus || 'unknown'} |
| **Score** | ${listing.score ?? 'Not scored'}/100 |

## Seller Information

| Field | Value |
|-------|-------|
| **Name** | ${listing.sellerName || 'Unknown'} |
| **Type** | ${listing.sellerType || 'Unknown'} |
| **Phone** | ${listing.sellerPhone || 'N/A'} |
| **Email** | ${listing.sellerEmail || 'N/A'} |
| **Location** | ${listing.city || ''}${listing.city && listing.province ? ', ' : ''}${listing.province || 'N/A'} |
| **Distance** | ${listing.distanceKm ?? 'N/A'} km |

## Vehicle Specifications

${Object.keys(specs).length > 0 ? Object.entries(specs).map(([k, v]) => `- **${k}:** ${v}`).join('\n') : 'No specifications available.'}

## Listing URL

${listing.sourceUrl}

## Description

${listing.description || 'No description available.'}

## Red Flags

${listing.redFlags?.map(f => `- ⚠️ ${f}`).join('\n') || 'None identified'}

## Notes

${listing.notes || 'None'}
`;
  fs.writeFileSync(path.join(listingDir, 'listing.md'), listingMd);

  // AI analysis (if available)
  if (listing.aiAnalysis) {
    try {
      const analysis = JSON.parse(listing.aiAnalysis);
      const analysisMd = `# AI Analysis

## Summary

${analysis.summary || 'No summary available.'}

## Score

**Overall Score:** ${analysis.recommendationScore || analysis.score || 'N/A'}/100

## Red Flags

${analysis.redFlags?.map((f: string) => `- ${f}`).join('\n') || 'None identified'}

## Positive Factors

${analysis.positives?.map((p: string) => `- ${p}`).join('\n') || 'None identified'}

## Concerns

${analysis.concerns?.map((c: string) => `- ${c}`).join('\n') || 'None identified'}

## Pricing Assessment

${analysis.pricing?.assessment || 'No pricing assessment available.'}

## Recommendation

${analysis.recommendation || 'No recommendation available.'}
`;
      fs.writeFileSync(path.join(listingDir, 'analysis.md'), analysisMd);
    } catch {
      // Ignore invalid JSON
    }
  }

  // Copy CARFAX if exists (file or directory of images)
  if (listing.carfaxPath && fs.existsSync(listing.carfaxPath)) {
    const carfaxStat = fs.statSync(listing.carfaxPath);
    if (carfaxStat.isDirectory()) {
      const carfaxImagesDir = path.join(listingDir, 'carfax-images');
      copyDirectory(listing.carfaxPath, carfaxImagesDir);
    } else {
      fs.copyFileSync(listing.carfaxPath, path.join(listingDir, 'carfax.pdf'));
    }
  }

  if (listing.carfaxSummary) {
    const carfaxMd = `# CARFAX Summary

${listing.carfaxSummary}

## Key Data

- **Accidents:** ${listing.accidentCount ?? 'Unknown'}
- **Owners:** ${listing.ownerCount ?? 'Unknown'}
- **Service Records:** ${listing.serviceRecordCount ?? 'Unknown'}
`;
    fs.writeFileSync(path.join(listingDir, 'carfax-summary.md'), carfaxMd);
  }

  // Copy saved attachments (if any)
  const attachmentSource = path.join('data', 'attachments', listing.id.toString());
  copyDirectory(attachmentSource, attachmentsDir);

  // Write conversation history
  if (listing.sellerConversation && listing.sellerConversation.length > 0) {
    writeConversationHistory(emailsDir, listing.sellerConversation);
  }

  return listingDir;
}
