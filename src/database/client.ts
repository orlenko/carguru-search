import Database from 'better-sqlite3';
import { SCHEMA, MIGRATIONS, type ListingStatus, type InfoStatus, type ListingState, isValidTransition, getStateDescription } from './schema.js';
import path from 'path';

export interface ConversationMessage {
  date: string;
  direction: 'outbound' | 'inbound';
  channel: 'email' | 'sms' | 'phone';
  subject?: string;
  body: string;
  attachments?: string[];
}

export interface EmailAttachment {
  id: number;
  listingId: number;
  emailId: number | null;
  filename: string;
  originalFilename: string;
  filePath: string;
  mimeType: string | null;
  sizeBytes: number | null;
  attachmentType: 'carfax' | 'photo' | 'document' | 'other' | null;
  isRelevant: boolean;
  receivedAt: string;
}

export interface NewEmailAttachment {
  listingId: number;
  emailId?: number;
  filename: string;
  originalFilename: string;
  filePath: string;
  mimeType?: string;
  sizeBytes?: number;
  attachmentType?: 'carfax' | 'photo' | 'document' | 'other';
  isRelevant?: boolean;
}

export interface VehicleSpecs {
  bodyType?: string;
  engine?: string;
  cylinders?: number;
  transmission?: string;
  drivetrain?: string;
  exteriorColor?: string;
  interiorColor?: string;
  doors?: number;
  fuelType?: string;
  passengers?: number;
  fuelCityL100km?: number;
  fuelHighwayL100km?: number;
  fuelCombinedL100km?: number;
}

export interface Listing {
  id: number;
  source: string;
  sourceId: string;
  sourceUrl: string;
  vin: string | null;
  year: number;
  make: string;
  model: string;
  trim: string | null;
  mileageKm: number | null;
  price: number | null;
  sellerType: string | null;
  sellerName: string | null;
  sellerPhone: string | null;
  sellerEmail: string | null;
  dealerRating: number | null;
  city: string | null;
  province: string | null;
  postalCode: string | null;
  distanceKm: number | null;
  description: string | null;
  features: string[] | null;
  photoUrls: string[] | null;
  status: ListingStatus;
  infoStatus: InfoStatus;
  exportedAt: string | null;
  score: number | null;
  redFlags: string[] | null;
  aiAnalysis: string | null;
  carfaxReceived: boolean;
  carfaxPath: string | null;
  accidentCount: number | null;
  ownerCount: number | null;
  serviceRecordCount: number | null;
  carfaxSummary: string | null;
  lastContactedAt: string | null;
  contactAttempts: number;
  // Timeline tracking
  firstResponseAt: string | null;
  lastSellerResponseAt: string | null;
  lastOurResponseAt: string | null;
  viewingScheduledFor: string | null;
  followUpDueAt: string | null;
  // Readiness tracking
  readinessScore: number | null;
  priceNegotiated: boolean;
  negotiatedPrice: number | null;
  // Notes
  notes: string | null;
  sellerConversation: ConversationMessage[] | null;
  // Vehicle specifications
  specs: VehicleSpecs | null;
  // Timestamps
  discoveredAt: string;
  analyzedAt: string | null;
  contactedAt: string | null;
  updatedAt: string;
}

export interface NewListing {
  source: string;
  sourceId: string;
  sourceUrl: string;
  vin?: string;
  year: number;
  make: string;
  model: string;
  trim?: string;
  mileageKm?: number;
  price?: number;
  sellerType?: string;
  sellerName?: string;
  sellerPhone?: string;
  sellerEmail?: string;
  dealerRating?: number;
  city?: string;
  province?: string;
  postalCode?: string;
  distanceKm?: number;
  description?: string;
  features?: string[];
  photoUrls?: string[];
  specs?: VehicleSpecs;
}

export class DatabaseClient {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath || process.env.DATABASE_PATH || './carsearch.db';
    this.db = new Database(resolvedPath);
    this.db.pragma('journal_mode = WAL');
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(SCHEMA);
    this.runMigrations();
  }

  private runMigrations(): void {
    // Run each migration, ignoring errors for already-applied migrations
    for (const migration of MIGRATIONS) {
      try {
        this.db.exec(migration);
      } catch (err) {
        // Ignore "duplicate column name" errors - migration already applied
        const message = err instanceof Error ? err.message : String(err);
        if (!message.includes('duplicate column name')) {
          console.error('Migration error:', message);
        }
      }
    }
  }

  /**
   * Insert or update a listing (upsert by source + sourceId)
   */
  upsertListing(listing: NewListing): number {
    const stmt = this.db.prepare(`
      INSERT INTO listings (
        source, sourceId, sourceUrl, vin, year, make, model, trim,
        mileageKm, price, sellerType, sellerName, sellerPhone, sellerEmail,
        dealerRating, city, province, postalCode, distanceKm, description,
        features, photoUrls, specs
      ) VALUES (
        @source, @sourceId, @sourceUrl, @vin, @year, @make, @model, @trim,
        @mileageKm, @price, @sellerType, @sellerName, @sellerPhone, @sellerEmail,
        @dealerRating, @city, @province, @postalCode, @distanceKm, @description,
        @features, @photoUrls, @specs
      )
      ON CONFLICT(source, sourceId) DO UPDATE SET
        sourceUrl = excluded.sourceUrl,
        vin = COALESCE(excluded.vin, vin),
        mileageKm = COALESCE(excluded.mileageKm, mileageKm),
        price = COALESCE(excluded.price, price),
        sellerPhone = COALESCE(excluded.sellerPhone, sellerPhone),
        sellerEmail = COALESCE(excluded.sellerEmail, sellerEmail),
        dealerRating = COALESCE(excluded.dealerRating, dealerRating),
        description = CASE
          WHEN excluded.description IS NOT NULL AND (description IS NULL OR length(excluded.description) > length(description))
          THEN excluded.description
          ELSE description
        END,
        features = COALESCE(excluded.features, features),
        photoUrls = COALESCE(excluded.photoUrls, photoUrls),
        specs = COALESCE(excluded.specs, specs),
        updatedAt = datetime('now')
      RETURNING id
    `);

    const result = stmt.get({
      ...listing,
      vin: listing.vin || null,
      trim: listing.trim || null,
      mileageKm: listing.mileageKm || null,
      price: listing.price || null,
      sellerType: listing.sellerType || null,
      sellerName: listing.sellerName || null,
      sellerPhone: listing.sellerPhone || null,
      sellerEmail: listing.sellerEmail || null,
      dealerRating: listing.dealerRating || null,
      city: listing.city || null,
      province: listing.province || null,
      postalCode: listing.postalCode || null,
      distanceKm: listing.distanceKm || null,
      description: listing.description || null,
      features: listing.features ? JSON.stringify(listing.features) : null,
      photoUrls: listing.photoUrls ? JSON.stringify(listing.photoUrls) : null,
      specs: listing.specs ? JSON.stringify(listing.specs) : null,
    }) as { id: number };

    return result.id;
  }

  /**
   * Get a listing by ID
   */
  getListing(id: number): Listing | null {
    const stmt = this.db.prepare('SELECT * FROM listings WHERE id = ?');
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToListing(row) : null;
  }

  /**
   * Get a listing by source and sourceId
   */
  getListingBySourceId(source: string, sourceId: string): Listing | null {
    const stmt = this.db.prepare('SELECT * FROM listings WHERE source = ? AND sourceId = ?');
    const row = stmt.get(source, sourceId) as Record<string, unknown> | undefined;
    return row ? this.rowToListing(row) : null;
  }

  /**
   * List all listings with optional filters
   */
  listListings(options: {
    status?: ListingStatus | ListingStatus[];
    source?: string;
    minScore?: number;
    limit?: number;
    orderBy?: 'score' | 'price' | 'mileage' | 'discovered';
  } = {}): Listing[] {
    let sql = 'SELECT * FROM listings WHERE 1=1';
    const params: unknown[] = [];

    if (options.status) {
      const statuses = Array.isArray(options.status) ? options.status : [options.status];
      sql += ` AND status IN (${statuses.map(() => '?').join(', ')})`;
      params.push(...statuses);
    }

    if (options.source) {
      sql += ' AND source = ?';
      params.push(options.source);
    }

    if (options.minScore !== undefined) {
      sql += ' AND score >= ?';
      params.push(options.minScore);
    }

    const orderMap = {
      score: 'score DESC NULLS LAST',
      price: 'price ASC NULLS LAST',
      mileage: 'mileageKm ASC NULLS LAST',
      discovered: 'discoveredAt DESC',
    };
    sql += ` ORDER BY ${orderMap[options.orderBy || 'discovered']}`;

    if (options.limit) {
      sql += ' LIMIT ?';
      params.push(options.limit);
    }

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as Record<string, unknown>[];
    return rows.map(row => this.rowToListing(row));
  }

  /**
   * Update listing fields
   */
  updateListing(id: number, updates: Partial<Omit<Listing, 'id' | 'discoveredAt'>>): void {
    const allowedFields = [
      'status', 'infoStatus', 'exportedAt', 'score', 'redFlags', 'aiAnalysis',
      'carfaxReceived', 'carfaxPath', 'accidentCount', 'ownerCount',
      'serviceRecordCount', 'carfaxSummary', 'lastContactedAt', 'contactAttempts',
      'notes', 'sellerConversation', 'vin', 'price', 'mileageKm', 'sellerPhone',
      'sellerEmail',
      // Timeline fields
      'firstResponseAt', 'lastSellerResponseAt', 'lastOurResponseAt',
      'viewingScheduledFor', 'followUpDueAt',
      // Readiness fields
      'readinessScore', 'priceNegotiated', 'negotiatedPrice',
      // Additional timestamps
      'analyzedAt', 'contactedAt',
    ];

    const fieldsToUpdate: string[] = [];
    const values: unknown[] = [];

    for (const [key, value] of Object.entries(updates)) {
      if (allowedFields.includes(key)) {
        fieldsToUpdate.push(`${key} = ?`);
        if ((key === 'redFlags' || key === 'sellerConversation') && Array.isArray(value)) {
          values.push(JSON.stringify(value));
        } else if (key === 'carfaxReceived') {
          values.push(value ? 1 : 0);
        } else {
          values.push(value);
        }
      }
    }

    if (fieldsToUpdate.length === 0) return;

    fieldsToUpdate.push("updatedAt = datetime('now')");

    const sql = `UPDATE listings SET ${fieldsToUpdate.join(', ')} WHERE id = ?`;
    values.push(id);

    this.db.prepare(sql).run(...values);
  }

  /**
   * Record a price change
   */
  recordPriceChange(listingId: number, price: number): void {
    this.db.prepare(`
      INSERT INTO price_history (listingId, price) VALUES (?, ?)
    `).run(listingId, price);
  }

  /**
   * Get price history for a listing
   */
  getPriceHistory(listingId: number): Array<{ price: number; recordedAt: string }> {
    return this.db.prepare(`
      SELECT price, recordedAt FROM price_history
      WHERE listingId = ? ORDER BY recordedAt DESC
    `).all(listingId) as Array<{ price: number; recordedAt: string }>;
  }

  /**
   * Get statistics
   */
  getStats(): {
    total: number;
    byStatus: Record<string, number>;
    bySource: Record<string, number>;
  } {
    const total = (this.db.prepare('SELECT COUNT(*) as count FROM listings').get() as { count: number }).count;

    const byStatus: Record<string, number> = {};
    const statusRows = this.db.prepare('SELECT status, COUNT(*) as count FROM listings GROUP BY status').all() as Array<{ status: string; count: number }>;
    for (const row of statusRows) {
      byStatus[row.status] = row.count;
    }

    const bySource: Record<string, number> = {};
    const sourceRows = this.db.prepare('SELECT source, COUNT(*) as count FROM listings GROUP BY source').all() as Array<{ source: string; count: number }>;
    for (const row of sourceRows) {
      bySource[row.source] = row.count;
    }

    return { total, byStatus, bySource };
  }

  /**
   * Record a search run
   */
  startSearchRun(source: string, searchParams: Record<string, unknown>): number {
    const result = this.db.prepare(`
      INSERT INTO search_runs (source, searchParams) VALUES (?, ?) RETURNING id
    `).get(source, JSON.stringify(searchParams)) as { id: number };
    return result.id;
  }

  completeSearchRun(id: number, listingsFound: number, newListings: number): void {
    this.db.prepare(`
      UPDATE search_runs SET
        status = 'completed',
        listingsFound = ?,
        newListings = ?,
        completedAt = datetime('now')
      WHERE id = ?
    `).run(listingsFound, newListings, id);
  }

  failSearchRun(id: number, error: string): void {
    this.db.prepare(`
      UPDATE search_runs SET
        status = 'failed',
        error = ?,
        completedAt = datetime('now')
      WHERE id = ?
    `).run(error, id);
  }

  private rowToListing(row: Record<string, unknown>): Listing {
    return {
      ...row,
      features: row.features ? JSON.parse(row.features as string) : null,
      photoUrls: row.photoUrls ? JSON.parse(row.photoUrls as string) : null,
      redFlags: row.redFlags ? JSON.parse(row.redFlags as string) : null,
      sellerConversation: row.sellerConversation ? JSON.parse(row.sellerConversation as string) : null,
      specs: row.specs ? JSON.parse(row.specs as string) : null,
      carfaxReceived: Boolean(row.carfaxReceived),
      infoStatus: (row.infoStatus as InfoStatus) || 'pending',
    } as Listing;
  }

  /**
   * Save an email attachment record
   */
  saveAttachment(attachment: NewEmailAttachment): number {
    const result = this.db.prepare(`
      INSERT INTO email_attachments (
        listingId, emailId, filename, originalFilename, filePath,
        mimeType, sizeBytes, attachmentType, isRelevant
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `).get(
      attachment.listingId,
      attachment.emailId || null,
      attachment.filename,
      attachment.originalFilename,
      attachment.filePath,
      attachment.mimeType || null,
      attachment.sizeBytes || null,
      attachment.attachmentType || null,
      attachment.isRelevant !== false ? 1 : 0
    ) as { id: number };
    return result.id;
  }

  /**
   * Get attachments for a listing
   */
  getAttachments(listingId: number): EmailAttachment[] {
    const rows = this.db.prepare(`
      SELECT * FROM email_attachments WHERE listingId = ? ORDER BY receivedAt DESC
    `).all(listingId) as Array<Record<string, unknown>>;

    return rows.map(row => ({
      ...row,
      isRelevant: Boolean(row.isRelevant),
    })) as EmailAttachment[];
  }

  /**
   * Get listings not yet exported (exportedAt is null)
   */
  getUnexportedListings(status?: ListingStatus | ListingStatus[]): Listing[] {
    let sql = 'SELECT * FROM listings WHERE exportedAt IS NULL';
    const params: unknown[] = [];

    if (status) {
      const statuses = Array.isArray(status) ? status : [status];
      sql += ` AND status IN (${statuses.map(() => '?').join(', ')})`;
      params.push(...statuses);
    }

    sql += ' ORDER BY discoveredAt DESC';

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(row => this.rowToListing(row));
  }

  /**
   * Mark listings as exported
   */
  markExported(ids: number[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(', ');
    this.db.prepare(`
      UPDATE listings SET exportedAt = datetime('now'), updatedAt = datetime('now')
      WHERE id IN (${placeholders})
    `).run(...ids);
  }

  /**
   * Get listings by specific IDs
   */
  getListingsByIds(ids: number[]): Listing[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    const rows = this.db.prepare(`
      SELECT * FROM listings WHERE id IN (${placeholders})
    `).all(...ids) as Record<string, unknown>[];
    return rows.map(row => this.rowToListing(row));
  }

  /**
   * Get emails for a listing
   */
  getEmailsForListing(listingId: number): Array<{
    id: number;
    direction: string;
    subject: string | null;
    body: string | null;
    fromAddress: string | null;
    toAddress: string | null;
    status: string;
    attachments: string | null;
    createdAt: string;
    sentAt: string | null;
  }> {
    return this.db.prepare(`
      SELECT * FROM emails WHERE listingId = ? ORDER BY createdAt ASC
    `).all(listingId) as Array<{
      id: number;
      direction: string;
      subject: string | null;
      body: string | null;
      fromAddress: string | null;
      toAddress: string | null;
      status: string;
      attachments: string | null;
      createdAt: string;
      sentAt: string | null;
    }>;
  }

  /**
   * Transition a listing to a new state with validation and audit logging
   */
  transitionState(
    listingId: number,
    newState: ListingState,
    options: {
      triggeredBy?: 'system' | 'user' | 'claude';
      reasoning?: string;
      context?: Record<string, unknown>;
    } = {}
  ): { success: boolean; error?: string } {
    const listing = this.getListing(listingId);
    if (!listing) {
      return { success: false, error: 'Listing not found' };
    }

    const currentState = listing.status as ListingState;

    // Validate transition
    if (!isValidTransition(currentState, newState)) {
      return {
        success: false,
        error: `Invalid transition from '${currentState}' to '${newState}'. Allowed: ${getStateDescription(currentState)}`,
      };
    }

    // Update the listing state
    this.updateListing(listingId, { status: newState });

    // Set timestamp based on state
    if (newState === 'analyzed') {
      this.updateListing(listingId, { analyzedAt: new Date().toISOString() });
    } else if (newState === 'contacted') {
      this.updateListing(listingId, { contactedAt: new Date().toISOString() });
    }

    // Log the transition
    this.logAudit({
      listingId,
      action: 'state_change',
      fromState: currentState,
      toState: newState,
      description: `State changed from '${currentState}' to '${newState}'`,
      reasoning: options.reasoning,
      context: options.context,
      triggeredBy: options.triggeredBy || 'system',
    });

    return { success: true };
  }

  /**
   * Log an audit entry
   */
  logAudit(entry: {
    listingId?: number;
    action: string;
    fromState?: string;
    toState?: string;
    description?: string;
    reasoning?: string;
    context?: Record<string, unknown>;
    triggeredBy?: string;
    sessionId?: string;
  }): number {
    const result = this.db.prepare(`
      INSERT INTO audit_log (
        listingId, action, fromState, toState, description,
        reasoning, context, triggeredBy, sessionId
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `).get(
      entry.listingId || null,
      entry.action,
      entry.fromState || null,
      entry.toState || null,
      entry.description || null,
      entry.reasoning || null,
      entry.context ? JSON.stringify(entry.context) : null,
      entry.triggeredBy || 'system',
      entry.sessionId || null
    ) as { id: number };
    return result.id;
  }

  /**
   * Get audit log for a listing
   */
  getAuditLog(listingId: number): Array<{
    id: number;
    action: string;
    fromState: string | null;
    toState: string | null;
    description: string | null;
    reasoning: string | null;
    triggeredBy: string;
    createdAt: string;
  }> {
    return this.db.prepare(`
      SELECT id, action, fromState, toState, description, reasoning, triggeredBy, createdAt
      FROM audit_log WHERE listingId = ? ORDER BY createdAt DESC
    `).all(listingId) as Array<{
      id: number;
      action: string;
      fromState: string | null;
      toState: string | null;
      description: string | null;
      reasoning: string | null;
      triggeredBy: string;
      createdAt: string;
    }>;
  }

  /**
   * Save or update cost breakdown for a listing
   */
  saveCostBreakdown(listingId: number, cost: {
    askingPrice?: number;
    negotiatedPrice?: number;
    estimatedFinalPrice?: number;
    fees?: Record<string, number>;
    taxRate?: number;
    taxAmount?: number;
    registrationIncluded?: boolean;
    registrationCost?: number;
    totalEstimatedCost?: number;
    budget?: number;
  }): void {
    const remainingBudget = cost.budget && cost.totalEstimatedCost
      ? cost.budget - cost.totalEstimatedCost
      : null;
    const withinBudget = remainingBudget !== null ? remainingBudget >= 0 : null;

    this.db.prepare(`
      INSERT INTO cost_breakdown (
        listingId, askingPrice, negotiatedPrice, estimatedFinalPrice,
        fees, taxRate, taxAmount, registrationIncluded, registrationCost,
        totalEstimatedCost, budget, remainingBudget, withinBudget
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(listingId) DO UPDATE SET
        askingPrice = excluded.askingPrice,
        negotiatedPrice = excluded.negotiatedPrice,
        estimatedFinalPrice = excluded.estimatedFinalPrice,
        fees = excluded.fees,
        taxRate = excluded.taxRate,
        taxAmount = excluded.taxAmount,
        registrationIncluded = excluded.registrationIncluded,
        registrationCost = excluded.registrationCost,
        totalEstimatedCost = excluded.totalEstimatedCost,
        budget = excluded.budget,
        remainingBudget = excluded.remainingBudget,
        withinBudget = excluded.withinBudget,
        updatedAt = datetime('now')
    `).run(
      listingId,
      cost.askingPrice || null,
      cost.negotiatedPrice || null,
      cost.estimatedFinalPrice || null,
      cost.fees ? JSON.stringify(cost.fees) : null,
      cost.taxRate || null,
      cost.taxAmount || null,
      cost.registrationIncluded !== undefined ? (cost.registrationIncluded ? 1 : 0) : null,
      cost.registrationCost || null,
      cost.totalEstimatedCost || null,
      cost.budget || null,
      remainingBudget,
      withinBudget !== null ? (withinBudget ? 1 : 0) : null
    );
  }

  /**
   * Get cost breakdown for a listing
   */
  getCostBreakdown(listingId: number): {
    askingPrice: number | null;
    negotiatedPrice: number | null;
    estimatedFinalPrice: number | null;
    fees: Record<string, number> | null;
    taxRate: number | null;
    taxAmount: number | null;
    registrationIncluded: boolean | null;
    registrationCost: number | null;
    totalEstimatedCost: number | null;
    budget: number | null;
    remainingBudget: number | null;
    withinBudget: boolean | null;
  } | null {
    const row = this.db.prepare(`
      SELECT * FROM cost_breakdown WHERE listingId = ?
    `).get(listingId) as Record<string, unknown> | undefined;

    if (!row) return null;

    return {
      askingPrice: row.askingPrice as number | null,
      negotiatedPrice: row.negotiatedPrice as number | null,
      estimatedFinalPrice: row.estimatedFinalPrice as number | null,
      fees: row.fees ? JSON.parse(row.fees as string) : null,
      taxRate: row.taxRate as number | null,
      taxAmount: row.taxAmount as number | null,
      registrationIncluded: row.registrationIncluded !== null ? Boolean(row.registrationIncluded) : null,
      registrationCost: row.registrationCost as number | null,
      totalEstimatedCost: row.totalEstimatedCost as number | null,
      budget: row.budget as number | null,
      remainingBudget: row.remainingBudget as number | null,
      withinBudget: row.withinBudget !== null ? Boolean(row.withinBudget) : null,
    };
  }

  /**
   * Calculate and update readiness score for a listing
   */
  calculateReadinessScore(listingId: number): number {
    const listing = this.getListing(listingId);
    if (!listing) return 0;

    let score = 0;

    // CARFAX received: +20
    if (listing.carfaxReceived) score += 20;

    // CARFAX clean (no accidents): +15
    if (listing.carfaxReceived && (listing.accidentCount === 0 || listing.accidentCount === null)) {
      score += 15;
    }

    // Price negotiated: +15
    if (listing.priceNegotiated) score += 15;

    // Within budget: +20 (check cost breakdown)
    const cost = this.getCostBreakdown(listingId);
    if (cost?.withinBudget) score += 20;

    // Seller responsive (has replied): +10
    if (listing.firstResponseAt) score += 10;

    // No red flags: +20
    if (!listing.redFlags || listing.redFlags.length === 0) score += 20;

    // Update the listing
    this.updateListing(listingId, { readinessScore: score });

    return score;
  }

  /**
   * Get listings needing follow-up (no response after X days)
   */
  getListingsNeedingFollowUp(daysSinceContact: number = 2): Listing[] {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysSinceContact);

    const rows = this.db.prepare(`
      SELECT * FROM listings
      WHERE status IN ('contacted', 'awaiting_response')
      AND lastContactedAt IS NOT NULL
      AND lastContactedAt < ?
      AND (lastSellerResponseAt IS NULL OR lastSellerResponseAt < lastContactedAt)
      ORDER BY lastContactedAt ASC
    `).all(cutoffDate.toISOString()) as Record<string, unknown>[];

    return rows.map(row => this.rowToListing(row));
  }

  // =========================================================================
  // Approval Queue Methods
  // =========================================================================

  /**
   * Queue an action for human approval
   */
  queueForApproval(entry: {
    listingId?: number;
    actionType: string;
    description: string;
    reasoning?: string;
    payload: Record<string, unknown>;
    checkpointType?: string;
    thresholdValue?: string;
    expiresAt?: string;
  }): number {
    const result = this.db.prepare(`
      INSERT INTO approval_queue (
        listingId, actionType, description, reasoning, payload,
        checkpointType, thresholdValue, expiresAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `).get(
      entry.listingId || null,
      entry.actionType,
      entry.description,
      entry.reasoning || null,
      JSON.stringify(entry.payload),
      entry.checkpointType || null,
      entry.thresholdValue || null,
      entry.expiresAt || null
    ) as { id: number };

    // Log to audit trail
    this.logAudit({
      listingId: entry.listingId,
      action: 'approval_queued',
      description: `Action '${entry.actionType}' queued for approval: ${entry.description}`,
      reasoning: entry.reasoning,
      context: { checkpointType: entry.checkpointType, thresholdValue: entry.thresholdValue },
      triggeredBy: 'system',
    });

    return result.id;
  }

  /**
   * Get pending approvals
   */
  getPendingApprovals(options: {
    listingId?: number;
    actionType?: string;
    limit?: number;
  } = {}): Array<{
    id: number;
    listingId: number | null;
    actionType: string;
    description: string;
    reasoning: string | null;
    payload: Record<string, unknown>;
    checkpointType: string | null;
    thresholdValue: string | null;
    createdAt: string;
    expiresAt: string | null;
  }> {
    let sql = `SELECT * FROM approval_queue WHERE status = 'pending'`;
    const params: unknown[] = [];

    if (options.listingId) {
      sql += ` AND listingId = ?`;
      params.push(options.listingId);
    }

    if (options.actionType) {
      sql += ` AND actionType = ?`;
      params.push(options.actionType);
    }

    // Exclude expired entries
    sql += ` AND (expiresAt IS NULL OR expiresAt > datetime('now'))`;

    sql += ` ORDER BY createdAt ASC`;

    if (options.limit) {
      sql += ` LIMIT ?`;
      params.push(options.limit);
    }

    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;

    return rows.map(row => ({
      id: row.id as number,
      listingId: row.listingId as number | null,
      actionType: row.actionType as string,
      description: row.description as string,
      reasoning: row.reasoning as string | null,
      payload: JSON.parse(row.payload as string),
      checkpointType: row.checkpointType as string | null,
      thresholdValue: row.thresholdValue as string | null,
      createdAt: row.createdAt as string,
      expiresAt: row.expiresAt as string | null,
    }));
  }

  /**
   * Approve a queued action
   */
  approveAction(approvalId: number, notes?: string): {
    success: boolean;
    payload?: Record<string, unknown>;
    error?: string;
  } {
    const row = this.db.prepare(`
      SELECT * FROM approval_queue WHERE id = ?
    `).get(approvalId) as Record<string, unknown> | undefined;

    if (!row) {
      return { success: false, error: 'Approval not found' };
    }

    if (row.status !== 'pending') {
      return { success: false, error: `Approval already ${row.status}` };
    }

    // Check if expired
    if (row.expiresAt && new Date(row.expiresAt as string) < new Date()) {
      this.db.prepare(`
        UPDATE approval_queue SET status = 'expired', resolvedAt = datetime('now')
        WHERE id = ?
      `).run(approvalId);
      return { success: false, error: 'Approval has expired' };
    }

    // Approve it
    this.db.prepare(`
      UPDATE approval_queue
      SET status = 'approved', resolvedBy = 'user', resolvedAt = datetime('now'), resolutionNotes = ?
      WHERE id = ?
    `).run(notes || null, approvalId);

    // Log to audit trail
    this.logAudit({
      listingId: row.listingId as number | undefined,
      action: 'approval_approved',
      description: `Action '${row.actionType}' approved: ${row.description}`,
      reasoning: notes,
      triggeredBy: 'user',
    });

    return {
      success: true,
      payload: JSON.parse(row.payload as string),
    };
  }

  /**
   * Reject a queued action
   */
  rejectAction(approvalId: number, notes?: string): { success: boolean; error?: string } {
    const row = this.db.prepare(`
      SELECT * FROM approval_queue WHERE id = ?
    `).get(approvalId) as Record<string, unknown> | undefined;

    if (!row) {
      return { success: false, error: 'Approval not found' };
    }

    if (row.status !== 'pending') {
      return { success: false, error: `Approval already ${row.status}` };
    }

    // Reject it
    this.db.prepare(`
      UPDATE approval_queue
      SET status = 'rejected', resolvedBy = 'user', resolvedAt = datetime('now'), resolutionNotes = ?
      WHERE id = ?
    `).run(notes || null, approvalId);

    // Log to audit trail
    this.logAudit({
      listingId: row.listingId as number | undefined,
      action: 'approval_rejected',
      description: `Action '${row.actionType}' rejected: ${row.description}`,
      reasoning: notes,
      triggeredBy: 'user',
    });

    return { success: true };
  }

  /**
   * Get approval queue stats
   */
  getApprovalStats(): {
    pending: number;
    approved: number;
    rejected: number;
    expired: number;
  } {
    const row = this.db.prepare(`
      SELECT
        SUM(CASE WHEN status = 'pending' AND (expiresAt IS NULL OR expiresAt > datetime('now')) THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) as approved,
        SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) as rejected,
        SUM(CASE WHEN status = 'expired' OR (status = 'pending' AND expiresAt <= datetime('now')) THEN 1 ELSE 0 END) as expired
      FROM approval_queue
    `).get() as Record<string, number>;

    return {
      pending: row.pending || 0,
      approved: row.approved || 0,
      rejected: row.rejected || 0,
      expired: row.expired || 0,
    };
  }

  close(): void {
    this.db.close();
  }
}

// Singleton instance
let instance: DatabaseClient | null = null;

export function getDatabase(): DatabaseClient {
  if (!instance) {
    instance = new DatabaseClient();
  }
  return instance;
}
