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
  status TEXT DEFAULT 'discovered',  -- 'discovered', 'analyzed', 'contacted', 'awaiting_response',
                                     -- 'negotiating', 'viewing_scheduled', 'inspected',
                                     -- 'offer_made', 'purchased', 'rejected', 'withdrawn'
  infoStatus TEXT DEFAULT 'pending', -- 'pending', 'carfax_requested', 'carfax_received', 'ready'
  exportedAt TEXT,                   -- ISO timestamp when exported to batch folder

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

  -- Timeline tracking (for state machine)
  firstResponseAt TEXT,              -- When seller first replied
  lastSellerResponseAt TEXT,         -- Last message from seller
  lastOurResponseAt TEXT,            -- Last message we sent
  viewingScheduledFor TEXT,          -- When viewing is booked
  followUpDueAt TEXT,                -- When to follow up if no response

  -- Deal readiness score components
  readinessScore INTEGER,            -- 0-100 calculated score
  priceNegotiated INTEGER DEFAULT 0, -- Boolean: have we negotiated?
  negotiatedPrice INTEGER,           -- Best price achieved so far

  -- Notes
  notes TEXT,                        -- User notes
  sellerConversation TEXT,           -- JSON array of conversation messages

  -- Timestamps
  discoveredAt TEXT DEFAULT (datetime('now')),
  analyzedAt TEXT,                   -- When AI analysis completed
  contactedAt TEXT,                  -- When first outreach sent
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

-- Email attachments table: track attachments from seller communications
CREATE TABLE IF NOT EXISTS email_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listingId INTEGER NOT NULL,
  emailId INTEGER,

  -- Attachment details
  filename TEXT NOT NULL,
  originalFilename TEXT NOT NULL,
  filePath TEXT NOT NULL,            -- Path in data/attachments/{listing_id}/
  mimeType TEXT,
  sizeBytes INTEGER,

  -- Classification
  attachmentType TEXT,               -- 'carfax', 'photo', 'document', 'other'
  isRelevant INTEGER DEFAULT 1,      -- Boolean: false for signatures, logos, etc.

  -- Timestamps
  receivedAt TEXT DEFAULT (datetime('now')),

  FOREIGN KEY (listingId) REFERENCES listings(id),
  FOREIGN KEY (emailId) REFERENCES emails(id)
);

CREATE INDEX IF NOT EXISTS idx_email_attachments_listing ON email_attachments(listingId);

-- Audit log table: track all automated actions
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listingId INTEGER,

  -- Action details
  action TEXT NOT NULL,              -- 'state_change', 'email_sent', 'offer_made', 'carfax_received', etc.
  fromState TEXT,                    -- Previous state (for state changes)
  toState TEXT,                      -- New state (for state changes)

  -- Context
  description TEXT,                  -- Human-readable description
  reasoning TEXT,                    -- AI reasoning if applicable
  context TEXT,                      -- JSON snapshot of relevant context

  -- Metadata
  triggeredBy TEXT,                  -- 'system', 'user', 'claude'
  sessionId TEXT,                    -- Claude session ID if applicable

  -- Timestamp
  createdAt TEXT DEFAULT (datetime('now')),

  FOREIGN KEY (listingId) REFERENCES listings(id)
);

CREATE INDEX IF NOT EXISTS idx_audit_log_listing ON audit_log(listingId);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(createdAt);

-- Cost breakdown table: track total cost calculations
CREATE TABLE IF NOT EXISTS cost_breakdown (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listingId INTEGER NOT NULL UNIQUE,

  -- Prices
  askingPrice INTEGER,
  negotiatedPrice INTEGER,
  estimatedFinalPrice INTEGER,

  -- Fees (JSON for flexibility)
  fees TEXT,                         -- JSON: {admin_fee, doc_fee, certification, other}

  -- Taxes
  taxRate REAL,                      -- e.g., 0.13 for 13% HST
  taxAmount INTEGER,

  -- Registration
  registrationIncluded INTEGER,      -- Boolean
  registrationCost INTEGER,

  -- Totals
  totalEstimatedCost INTEGER,
  budget INTEGER,
  remainingBudget INTEGER,
  withinBudget INTEGER,              -- Boolean

  -- Timestamps
  calculatedAt TEXT DEFAULT (datetime('now')),
  updatedAt TEXT DEFAULT (datetime('now')),

  FOREIGN KEY (listingId) REFERENCES listings(id)
);

CREATE INDEX IF NOT EXISTS idx_cost_breakdown_listing ON cost_breakdown(listingId);

-- Approval queue table: pending actions requiring human approval
CREATE TABLE IF NOT EXISTS approval_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listingId INTEGER,

  -- Action details
  actionType TEXT NOT NULL,           -- 'send_offer', 'schedule_viewing', 'send_email', 'follow_up'
  description TEXT NOT NULL,          -- Human-readable description of the action
  reasoning TEXT,                     -- AI reasoning for this action

  -- Payload (the actual action data)
  payload TEXT NOT NULL,              -- JSON: the data needed to execute the action

  -- Checkpoint that triggered this
  checkpointType TEXT,                -- 'offer_threshold', 'viewing_approval', 'unusual_behavior', etc.
  thresholdValue TEXT,                -- The threshold that was exceeded (for reference)

  -- Status
  status TEXT DEFAULT 'pending',      -- 'pending', 'approved', 'rejected', 'expired'

  -- Resolution
  resolvedBy TEXT,                    -- 'user' or null
  resolvedAt TEXT,
  resolutionNotes TEXT,               -- User notes when approving/rejecting

  -- Timestamps
  createdAt TEXT DEFAULT (datetime('now')),
  expiresAt TEXT,                     -- Optional expiry for time-sensitive actions

  FOREIGN KEY (listingId) REFERENCES listings(id)
);

CREATE INDEX IF NOT EXISTS idx_approval_queue_status ON approval_queue(status);
CREATE INDEX IF NOT EXISTS idx_approval_queue_listing ON approval_queue(listingId);
`;

/**
 * Migrations for existing databases
 * These are run after the main schema to add new columns to existing tables
 */
export const MIGRATIONS = [
  // Add infoStatus column if it doesn't exist
  `ALTER TABLE listings ADD COLUMN infoStatus TEXT DEFAULT 'pending'`,
  // Add exportedAt column if it doesn't exist
  `ALTER TABLE listings ADD COLUMN exportedAt TEXT`,
  // Add sellerConversation column if it doesn't exist
  `ALTER TABLE listings ADD COLUMN sellerConversation TEXT`,
  // Timeline tracking fields
  `ALTER TABLE listings ADD COLUMN firstResponseAt TEXT`,
  `ALTER TABLE listings ADD COLUMN lastSellerResponseAt TEXT`,
  `ALTER TABLE listings ADD COLUMN lastOurResponseAt TEXT`,
  `ALTER TABLE listings ADD COLUMN viewingScheduledFor TEXT`,
  `ALTER TABLE listings ADD COLUMN followUpDueAt TEXT`,
  // Readiness score fields
  `ALTER TABLE listings ADD COLUMN readinessScore INTEGER`,
  `ALTER TABLE listings ADD COLUMN priceNegotiated INTEGER DEFAULT 0`,
  `ALTER TABLE listings ADD COLUMN negotiatedPrice INTEGER`,
  // Additional timestamps
  `ALTER TABLE listings ADD COLUMN analyzedAt TEXT`,
  `ALTER TABLE listings ADD COLUMN contactedAt TEXT`,
  // Vehicle specifications (JSON)
  `ALTER TABLE listings ADD COLUMN specs TEXT`,
];

/**
 * Listing State Machine
 *
 * State flow:
 *   discovered → analyzed → contacted → awaiting_response → negotiating →
 *   viewing_scheduled → inspected → offer_made → purchased
 *                                            ↘ rejected / withdrawn
 */
export const LISTING_STATES = [
  'discovered',         // Just found in search
  'analyzed',           // AI analysis complete
  'contacted',          // Initial outreach sent
  'awaiting_response',  // Waiting for seller reply
  'negotiating',        // Active back-and-forth
  'viewing_scheduled',  // In-person viewing booked
  'inspected',          // Seen in person
  'offer_made',         // Formal offer submitted
  'purchased',          // Deal closed - we bought it
  'rejected',           // We walked away
  'withdrawn',          // Seller withdrew / sold to someone else
] as const;

export type ListingState = typeof LISTING_STATES[number];

/**
 * Valid state transitions
 * Maps from current state to allowed next states
 */
export const STATE_TRANSITIONS: Record<ListingState, ListingState[]> = {
  'discovered':         ['analyzed', 'rejected'],
  'analyzed':           ['contacted', 'rejected'],
  'contacted':          ['awaiting_response', 'rejected', 'withdrawn'],
  'awaiting_response':  ['negotiating', 'rejected', 'withdrawn'],
  'negotiating':        ['viewing_scheduled', 'offer_made', 'rejected', 'withdrawn'],
  'viewing_scheduled':  ['inspected', 'rejected', 'withdrawn'],
  'inspected':          ['offer_made', 'rejected'],
  'offer_made':         ['purchased', 'negotiating', 'rejected', 'withdrawn'],
  'purchased':          [], // Terminal state
  'rejected':           [], // Terminal state (could allow reactivation if needed)
  'withdrawn':          [], // Terminal state
};

/**
 * Check if a state transition is valid
 */
export function isValidTransition(from: ListingState, to: ListingState): boolean {
  return STATE_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Get human-readable state description
 */
export function getStateDescription(state: ListingState): string {
  const descriptions: Record<ListingState, string> = {
    'discovered': 'Found in search',
    'analyzed': 'AI analysis complete',
    'contacted': 'Initial outreach sent',
    'awaiting_response': 'Waiting for seller reply',
    'negotiating': 'Active negotiation',
    'viewing_scheduled': 'Viewing booked',
    'inspected': 'Seen in person',
    'offer_made': 'Offer submitted',
    'purchased': 'Purchased!',
    'rejected': 'Not pursuing',
    'withdrawn': 'No longer available',
  };
  return descriptions[state];
}

// Keep old type for backward compatibility during migration
export const LISTING_STATUSES = LISTING_STATES;
export type ListingStatus = ListingState;

export const INFO_STATUSES = [
  'pending',          // No info collected yet
  'carfax_requested', // CARFAX requested but not received
  'carfax_received',  // CARFAX received
  'ready',            // All info collected, ready for export
] as const;

export type InfoStatus = typeof INFO_STATUSES[number];
