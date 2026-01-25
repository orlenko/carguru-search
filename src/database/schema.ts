/**
 * Database schema for car search tracking
 */

export const SCHEMA = `
-- Listings table: all discovered vehicle listings
CREATE TABLE IF NOT EXISTS listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Source information
  source TEXT NOT NULL,              -- 'cargurus', 'autotrader', 'kijiji'
  sourceId TEXT NOT NULL,            -- ID on the source site
  sourceUrl TEXT NOT NULL,           -- Full URL to listing

  -- Vehicle information
  vin TEXT,                          -- Vehicle Identification Number
  year INTEGER NOT NULL,
  make TEXT NOT NULL,
  model TEXT NOT NULL,
  trim TEXT,
  mileageKm INTEGER,
  price INTEGER,                     -- CAD

  -- Seller information
  sellerType TEXT,                   -- 'dealer', 'private'
  sellerName TEXT,
  sellerPhone TEXT,
  sellerEmail TEXT,
  dealerRating REAL,                 -- 0-5 stars if available

  -- Location
  city TEXT,
  province TEXT,
  postalCode TEXT,
  distanceKm INTEGER,                -- Distance from search location

  -- Listing details
  description TEXT,
  features TEXT,                     -- JSON array of features
  photoUrls TEXT,                    -- JSON array of photo URLs

  -- Status tracking
  status TEXT DEFAULT 'new',         -- 'new', 'contacted', 'carfax_requested',
                                     -- 'carfax_received', 'analyzed', 'shortlisted',
                                     -- 'rejected', 'viewing_scheduled', 'offer_made'

  -- Analysis results
  score REAL,                        -- 0-100 composite score
  redFlags TEXT,                     -- JSON array of detected issues
  aiAnalysis TEXT,                   -- Full AI analysis text

  -- CARFAX data (if received)
  carfaxReceived INTEGER DEFAULT 0,  -- Boolean
  carfaxPath TEXT,                   -- Path to saved CARFAX PDF
  accidentCount INTEGER,
  ownerCount INTEGER,
  serviceRecordCount INTEGER,
  carfaxSummary TEXT,                -- AI summary of CARFAX

  -- Communication tracking
  lastContactedAt TEXT,              -- ISO timestamp
  contactAttempts INTEGER DEFAULT 0,

  -- Notes
  notes TEXT,                        -- User notes

  -- Timestamps
  discoveredAt TEXT DEFAULT (datetime('now')),
  updatedAt TEXT DEFAULT (datetime('now')),

  -- Ensure no duplicate listings from same source
  UNIQUE(source, sourceId)
);

-- Index for common queries
CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status);
CREATE INDEX IF NOT EXISTS idx_listings_score ON listings(score DESC);
CREATE INDEX IF NOT EXISTS idx_listings_source ON listings(source);
CREATE INDEX IF NOT EXISTS idx_listings_vin ON listings(vin);

-- Emails table: track all communications
CREATE TABLE IF NOT EXISTS emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listingId INTEGER,

  -- Email details
  direction TEXT NOT NULL,           -- 'outbound', 'inbound'
  subject TEXT,
  body TEXT,
  fromAddress TEXT,
  toAddress TEXT,

  -- Status
  status TEXT DEFAULT 'draft',       -- 'draft', 'sent', 'received', 'failed'

  -- Attachments
  attachments TEXT,                  -- JSON array of {filename, path}

  -- Timestamps
  createdAt TEXT DEFAULT (datetime('now')),
  sentAt TEXT,

  FOREIGN KEY (listingId) REFERENCES listings(id)
);

CREATE INDEX IF NOT EXISTS idx_emails_listing ON emails(listingId);

-- Search runs table: track each search execution
CREATE TABLE IF NOT EXISTS search_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  source TEXT NOT NULL,
  searchParams TEXT NOT NULL,        -- JSON of search parameters

  listingsFound INTEGER DEFAULT 0,
  newListings INTEGER DEFAULT 0,

  status TEXT DEFAULT 'running',     -- 'running', 'completed', 'failed'
  error TEXT,

  startedAt TEXT DEFAULT (datetime('now')),
  completedAt TEXT
);

-- Price history table: track price changes
CREATE TABLE IF NOT EXISTS price_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listingId INTEGER NOT NULL,

  price INTEGER NOT NULL,
  recordedAt TEXT DEFAULT (datetime('now')),

  FOREIGN KEY (listingId) REFERENCES listings(id)
);

CREATE INDEX IF NOT EXISTS idx_price_history_listing ON price_history(listingId);
`;

/**
 * Status flow for listings
 */
export const LISTING_STATUSES = [
  'new',              // Just discovered
  'contacted',        // Initial contact made
  'carfax_requested', // CARFAX report requested
  'carfax_received',  // CARFAX received, pending analysis
  'analyzed',         // AI analysis complete
  'shortlisted',      // Passes all checks, worth pursuing
  'rejected',         // Failed checks or not interested
  'viewing_scheduled',// In-person viewing scheduled
  'offer_made',       // Offer submitted
] as const;

export type ListingStatus = typeof LISTING_STATUSES[number];
