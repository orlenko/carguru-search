/**
 * Email Link Processor
 * Extracts links from dealer emails and fetches additional info from linked pages
 */

import type { IncomingEmail } from './client.js';
import type { Listing } from '../database/client.js';
import { getDatabase } from '../database/index.js';
import path from 'path';
import fs from 'fs';
import { runClaudeTask } from '../claude/task-runner.js';
import { syncListingToWorkspace, writeSearchContext } from '../workspace/index.js';

const CLAUDE_SENTINEL = 'task complete';

export interface ExtractedLink {
  url: string;
  text: string;
  domain: string;
  type: 'listing' | 'inventory' | 'carfax' | 'photo' | 'other';
}

export interface LinkContent {
  url: string;
  title: string;
  description: string | null;
  vin: string | null;
  price: number | null;
  mileage: number | null;
  specs: Record<string, string>;
  photoUrls: string[];
  carfaxUrl: string | null;
  rawText: string;
}

/**
 * Extract all URLs from email text and HTML
 */
export function extractLinksFromEmail(email: IncomingEmail): ExtractedLink[] {
  const links: Map<string, ExtractedLink> = new Map();

  // URL regex pattern
  const urlPattern = /https?:\/\/[^\s<>"')\]]+/gi;

  // Extract from plain text
  const textMatches = email.text.match(urlPattern) || [];
  for (const url of textMatches) {
    if (!links.has(url)) {
      links.set(url, classifyLink(url, ''));
    }
  }

  // Extract from HTML with link text
  if (email.html) {
    // Match <a href="url">text</a>
    const anchorPattern = /<a[^>]+href=["']([^"']+)["'][^>]*>([^<]*)</gi;
    let match;
    while ((match = anchorPattern.exec(email.html)) !== null) {
      const url = match[1];
      const text = match[2].trim();
      if (url.startsWith('http') && !links.has(url)) {
        links.set(url, classifyLink(url, text));
      }
    }

    // Also get URLs from HTML that might not be in anchors
    const htmlMatches = email.html.match(urlPattern) || [];
    for (const url of htmlMatches) {
      if (!links.has(url)) {
        links.set(url, classifyLink(url, ''));
      }
    }
  }

  return Array.from(links.values());
}

/**
 * Classify a link based on URL pattern and link text
 */
function classifyLink(url: string, text: string): ExtractedLink {
  const lowerUrl = url.toLowerCase();
  const lowerText = text.toLowerCase();
  let domain = '';

  try {
    domain = new URL(url).hostname;
  } catch {
    domain = 'unknown';
  }

  let type: ExtractedLink['type'] = 'other';

  // CARFAX detection
  if (lowerUrl.includes('carfax') || lowerText.includes('carfax') || lowerText.includes('vehicle history')) {
    type = 'carfax';
  }
  // Listing page detection
  else if (
    lowerUrl.includes('/vehicle/') ||
    lowerUrl.includes('/listing/') ||
    lowerUrl.includes('/inventory/') ||
    lowerUrl.includes('/vdp/') ||  // Vehicle Detail Page
    lowerUrl.includes('/used-car/') ||
    lowerUrl.includes('autotrader') ||
    lowerUrl.includes('kijiji') ||
    /\/\d{5,}/.test(lowerUrl)  // URL with numeric ID
  ) {
    type = 'listing';
  }
  // Inventory page detection
  else if (
    lowerUrl.includes('/inventory') ||
    lowerUrl.includes('/vehicles') ||
    lowerUrl.includes('/used-cars') ||
    lowerText.includes('view inventory') ||
    lowerText.includes('see more')
  ) {
    type = 'inventory';
  }
  // Photo detection
  else if (
    /\.(jpg|jpeg|png|gif|webp)(\?|$)/i.test(lowerUrl) ||
    lowerUrl.includes('/photos/') ||
    lowerUrl.includes('/images/')
  ) {
    type = 'photo';
  }

  return { url, text, domain, type };
}

/**
 * Filter links to only relevant ones for a car listing
 */
export function filterRelevantLinks(links: ExtractedLink[]): ExtractedLink[] {
  // Skip domains that are definitely not useful
  const skipDomains = [
    'unsubscribe',
    'click.email',
    'tracking.',
    'pixel.',
    'analytics.',
    'facebook.com',
    'twitter.com',
    'instagram.com',
    'linkedin.com',
    'youtube.com',
    'google.com/maps',
    'mailto:',
  ];

  return links.filter(link => {
    const lowerUrl = link.url.toLowerCase();

    // Skip tracking/social links
    for (const skip of skipDomains) {
      if (lowerUrl.includes(skip)) return false;
    }

    // Prioritize listing, carfax, and inventory links
    if (link.type === 'listing' || link.type === 'carfax' || link.type === 'inventory') {
      return true;
    }

    // Skip most "other" type links unless they look promising
    if (link.type === 'other') {
      // Keep if it's from a dealer domain or has promising text
      const dealerKeywords = ['dealer', 'auto', 'motors', 'cars', 'vehicle'];
      if (dealerKeywords.some(k => link.domain.includes(k))) {
        return true;
      }
      if (['view', 'details', 'more info'].some(t => link.text.toLowerCase().includes(t))) {
        return true;
      }
      return false;
    }

    return true;
  });
}

/**
 * Fetch and analyze content from a URL using Claude
 */
export async function fetchAndAnalyzeLink(url: string, workspaceDir: string): Promise<LinkContent | null> {
  const prompt = `Fetch and analyze this URL:
${url}

Analyze the car listing/dealer page content and extract:
1. Vehicle details (year, make, model, trim, VIN if visible)
2. Price (number only)
3. Mileage/odometer (in km)
4. Any specifications (engine, transmission, drivetrain, color, etc.)
5. Photo URLs (direct image links)
6. CARFAX or vehicle history report links
7. Any other useful info

Respond with JSON only:
{
  "title": "page title or vehicle name",
  "description": "brief description of what the page contains",
  "vin": "VIN if found or null",
  "price": 12345 or null,
  "mileage": 95000 or null,
  "specs": {"key": "value"},
  "photoUrls": ["url1", "url2"],
  "carfaxUrl": "url or null",
  "rawText": "relevant text from the page (max 500 chars)"
}

If the page is not a car listing (e.g., generic homepage, error page), return:
{"title": "page title", "description": "not a vehicle listing", "vin": null, "price": null, "mileage": null, "specs": {}, "photoUrls": [], "carfaxUrl": null, "rawText": ""}`;

  try {
    const taskDir = path.join(workspaceDir, 'claude', `link-analysis-${Date.now()}`);
    fs.mkdirSync(taskDir, { recursive: true });
    const taskFile = path.join(taskDir, 'task.md');
    const resultFile = path.join(taskDir, 'result.json');
    const resultRel = path.relative(workspaceDir, resultFile);

    const taskBody = `${prompt}

---

Write ONLY the JSON to: ${resultRel}

After writing the file, output this line exactly:
${CLAUDE_SENTINEL}
`;
    fs.writeFileSync(taskFile, taskBody);

    await runClaudeTask({
      workspaceDir,
      taskFile: path.relative(workspaceDir, taskFile),
      resultFile: resultRel,
      model: process.env.CLAUDE_MODEL_LINK || process.env.CLAUDE_MODEL || undefined,
      dangerous: process.env.CLAUDE_DANGEROUS !== 'false',
      timeoutMs: 60000,
      sentinel: CLAUDE_SENTINEL,
    });

    if (!fs.existsSync(resultFile)) {
      throw new Error('Claude did not write a result file');
    }

    const raw = fs.readFileSync(resultFile, 'utf-8');
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        url,
        title: parsed.title || '',
        description: parsed.description || null,
        vin: parsed.vin || null,
        price: parsed.price || null,
        mileage: parsed.mileage || null,
        specs: parsed.specs || {},
        photoUrls: parsed.photoUrls || [],
        carfaxUrl: parsed.carfaxUrl || null,
        rawText: parsed.rawText || '',
      };
    }
  } catch (error) {
    console.error(`Failed to analyze link ${url}:`, error);
  }

  return null;
}

/**
 * Process all links from a dealer email and enrich listing data
 */
export async function processEmailLinks(
  email: IncomingEmail,
  listing: Listing
): Promise<{
  linksFound: number;
  linksProcessed: number;
  enrichedData: Partial<Listing>;
  carfaxUrl: string | null;
  additionalPhotos: string[];
}> {
  const db = getDatabase();
  writeSearchContext();
  const listingDir = syncListingToWorkspace(listing);

  // Extract and filter links
  const allLinks = extractLinksFromEmail(email);
  const relevantLinks = filterRelevantLinks(allLinks);

  console.log(`  Found ${allLinks.length} links, ${relevantLinks.length} relevant`);

  const result = {
    linksFound: allLinks.length,
    linksProcessed: 0,
    enrichedData: {} as Partial<Listing>,
    carfaxUrl: null as string | null,
    additionalPhotos: [] as string[],
  };

  // Process CARFAX links first (high priority)
  const carfaxLinks = relevantLinks.filter(l => l.type === 'carfax');
  for (const link of carfaxLinks) {
    result.carfaxUrl = link.url;
    console.log(`    📄 CARFAX link found: ${link.url}`);
    result.linksProcessed++;
  }

  // Process listing links
  const listingLinks = relevantLinks.filter(l => l.type === 'listing');
  for (const link of listingLinks.slice(0, 3)) { // Limit to 3 listing links
    console.log(`    🔗 Analyzing listing link: ${link.url.slice(0, 60)}...`);

    const content = await fetchAndAnalyzeLink(link.url, listingDir);
    if (content) {
      result.linksProcessed++;

      // Extract VIN if we don't have one
      if (content.vin && !listing.vin) {
        result.enrichedData.vin = content.vin;
        console.log(`      ✅ Found VIN: ${content.vin}`);
      }

      // Collect photo URLs
      if (content.photoUrls.length > 0) {
        result.additionalPhotos.push(...content.photoUrls);
        console.log(`      📷 Found ${content.photoUrls.length} photos`);
      }

      // Extract CARFAX URL if found
      if (content.carfaxUrl && !result.carfaxUrl) {
        result.carfaxUrl = content.carfaxUrl;
        console.log(`      📄 Found CARFAX link: ${content.carfaxUrl}`);
      }
    }

    // Rate limit between requests
    await new Promise(r => setTimeout(r, 2000));
  }

  // Log audit entry
  db.logAudit({
    listingId: listing.id,
    action: 'email_links_processed',
    description: `Processed ${result.linksProcessed} links from email`,
    context: {
      linksFound: result.linksFound,
      linksProcessed: result.linksProcessed,
      carfaxFound: !!result.carfaxUrl,
      photosFound: result.additionalPhotos.length,
    },
    triggeredBy: 'system',
  });

  return result;
}

/**
 * Simple URL extraction without classification (for quick use)
 */
export function extractUrls(text: string): string[] {
  const urlPattern = /https?:\/\/[^\s<>"')\]]+/gi;
  return text.match(urlPattern) || [];
}
