import type { IncomingEmail } from './client.js';
import type { Listing } from '../database/client.js';
import { extractSenderEmail } from './client.js';
import { extractLinksFromEmail } from './link-processor.js';

function extractAutoTraderIds(urls: string[]): Set<string> {
  const ids = new Set<string>();
  for (const url of urls) {
    if (!url.includes('autotrader.ca')) continue;
    const match = url.match(/(\d+_\d+_\d+)/);
    if (match) {
      ids.add(match[1]);
    }
  }
  return ids;
}

function extractVin(text: string): string | null {
  const match = text.match(/[A-HJ-NPR-Z0-9]{17}/i);
  return match ? match[0].toUpperCase() : null;
}

export function matchListingFromEmail(
  email: IncomingEmail,
  listings: Listing[]
): Listing | null {
  const senderEmail = extractSenderEmail(email);

  if (senderEmail) {
    const byEmail = listings.find(l => l.sellerEmail && l.sellerEmail.toLowerCase() === senderEmail);
    if (byEmail) return byEmail;
  }

  const links = extractLinksFromEmail(email);
  const linkUrls = links.map(l => l.url);
  const autoTraderIds = extractAutoTraderIds(linkUrls);

  for (const listing of listings) {
    if (listing.sourceUrl) {
      const sourceUrl = listing.sourceUrl.toLowerCase();
      if (linkUrls.some(url => url.toLowerCase().includes(sourceUrl) || sourceUrl.includes(url.toLowerCase()))) {
        return listing;
      }
    }
    if (listing.sourceId && autoTraderIds.has(listing.sourceId)) {
      return listing;
    }
  }

  const vin = extractVin(email.text || '');
  if (vin) {
    const byVin = listings.find(l => l.vin && l.vin.toUpperCase() === vin);
    if (byVin) return byVin;
  }

  const subjectLower = email.subject.toLowerCase();
  const textLower = email.text.toLowerCase();
  for (const listing of listings) {
    const vehicle = `${listing.make} ${listing.model}`.toLowerCase();
    if (subjectLower.includes(vehicle) || textLower.includes(vehicle)) {
      return listing;
    }
  }

  for (const listing of listings) {
    if (listing.sellerName && email.from.toLowerCase().includes(listing.sellerName.toLowerCase())) {
      return listing;
    }
  }

  return null;
}
