import type { NewListing } from '../database/client.js';
import type { SearchConfig } from '../config.js';

export interface ScraperResult {
  listings: NewListing[];
  totalFound: number;
  pagesFetched: number;
}

export interface Scraper {
  name: string;
  search(config: SearchConfig): Promise<ScraperResult>;
}
