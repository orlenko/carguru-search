/**
 * Database client for web UI
 * Connects to the same SQLite database as the CLI
 */
import Database from 'better-sqlite3';
import path from 'path';

// Database path - the database is in the project root (not data/)
import { existsSync } from 'fs';

function findDatabasePath(): string {
  const cwd = process.cwd();

  const possiblePaths = [
    // From web/ directory - database is in parent (project root)
    path.resolve(cwd, '..', 'carsearch.db'),
    // From project root
    path.resolve(cwd, 'carsearch.db'),
  ];

  for (const dbPath of possiblePaths) {
    if (existsSync(dbPath)) {
      console.log('Using database:', dbPath);
      return dbPath;
    }
  }

  // Default to first path
  return possiblePaths[0];
}

const DB_PATH = findDatabasePath();

let dbInstance: Database.Database | null = null;

function getDb(): Database.Database {
  if (!dbInstance) {
    dbInstance = new Database(DB_PATH);
    dbInstance.pragma('journal_mode = WAL');
  }
  return dbInstance;
}

// Types
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
  status: string;
  infoStatus: string | null;
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
  firstResponseAt: string | null;
  lastSellerResponseAt: string | null;
  lastOurResponseAt: string | null;
  viewingScheduledFor: string | null;
  followUpDueAt: string | null;
  readinessScore: number | null;
  priceNegotiated: boolean;
  negotiatedPrice: number | null;
  notes: string | null;
  sellerConversation: Array<{ direction: string; content: string; timestamp: string }> | null;
  discoveredAt: string;
  analyzedAt: string | null;
  contactedAt: string | null;
  updatedAt: string;
}

export interface CostBreakdown {
  listingId: number;
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
}

export interface AuditEntry {
  id: number;
  listingId: number | null;
  action: string;
  fromState: string | null;
  toState: string | null;
  description: string | null;
  reasoning: string | null;
  triggeredBy: string;
  createdAt: string;
}

export interface PendingApproval {
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
}

export interface Email {
  id: number;
  listingId: number;
  direction: string;
  subject: string | null;
  body: string | null;
  fromAddress: string | null;
  toAddress: string | null;
  status: string;
  attachments: string | null;
  createdAt: string;
  sentAt: string | null;
}

// Helper to parse JSON fields
function parseJsonField<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

// Convert database row to Listing
function rowToListing(row: Record<string, unknown>): Listing {
  return {
    id: row.id as number,
    source: row.source as string,
    sourceId: row.sourceId as string,
    sourceUrl: row.sourceUrl as string,
    vin: row.vin as string | null,
    year: row.year as number,
    make: row.make as string,
    model: row.model as string,
    trim: row.trim as string | null,
    mileageKm: row.mileageKm as number | null,
    price: row.price as number | null,
    sellerType: row.sellerType as string | null,
    sellerName: row.sellerName as string | null,
    sellerPhone: row.sellerPhone as string | null,
    sellerEmail: row.sellerEmail as string | null,
    dealerRating: row.dealerRating as number | null,
    city: row.city as string | null,
    province: row.province as string | null,
    postalCode: row.postalCode as string | null,
    distanceKm: row.distanceKm as number | null,
    description: row.description as string | null,
    features: parseJsonField<string[]>(row.features as string | null),
    photoUrls: parseJsonField<string[]>(row.photoUrls as string | null),
    status: row.status as string,
    infoStatus: row.infoStatus as string | null,
    exportedAt: row.exportedAt as string | null,
    score: row.score as number | null,
    redFlags: parseJsonField<string[]>(row.redFlags as string | null),
    aiAnalysis: row.aiAnalysis as string | null,
    carfaxReceived: Boolean(row.carfaxReceived),
    carfaxPath: row.carfaxPath as string | null,
    accidentCount: row.accidentCount as number | null,
    ownerCount: row.ownerCount as number | null,
    serviceRecordCount: row.serviceRecordCount as number | null,
    carfaxSummary: row.carfaxSummary as string | null,
    lastContactedAt: row.lastContactedAt as string | null,
    contactAttempts: (row.contactAttempts as number) || 0,
    firstResponseAt: row.firstResponseAt as string | null,
    lastSellerResponseAt: row.lastSellerResponseAt as string | null,
    lastOurResponseAt: row.lastOurResponseAt as string | null,
    viewingScheduledFor: row.viewingScheduledFor as string | null,
    followUpDueAt: row.followUpDueAt as string | null,
    readinessScore: row.readinessScore as number | null,
    priceNegotiated: Boolean(row.priceNegotiated),
    negotiatedPrice: row.negotiatedPrice as number | null,
    notes: row.notes as string | null,
    sellerConversation: parseJsonField<Array<{ direction: string; content: string; timestamp: string }>>(row.sellerConversation as string | null),
    discoveredAt: row.discoveredAt as string,
    analyzedAt: row.analyzedAt as string | null,
    contactedAt: row.contactedAt as string | null,
    updatedAt: row.updatedAt as string,
  };
}

// Database functions
export function getListings(options: {
  status?: string | string[];
  limit?: number;
  offset?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
} = {}): Listing[] {
  const db = getDb();
  let sql = 'SELECT * FROM listings WHERE 1=1';
  const params: unknown[] = [];

  if (options.status) {
    const statuses = Array.isArray(options.status) ? options.status : [options.status];
    sql += ` AND status IN (${statuses.map(() => '?').join(', ')})`;
    params.push(...statuses);
  }

  const sortBy = options.sortBy || 'discoveredAt';
  const sortOrder = options.sortOrder || 'desc';
  sql += ` ORDER BY ${sortBy} ${sortOrder.toUpperCase()}`;

  if (options.limit) {
    sql += ' LIMIT ?';
    params.push(options.limit);
  }

  if (options.offset) {
    sql += ' OFFSET ?';
    params.push(options.offset);
  }

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
  return rows.map(rowToListing);
}

export function getListing(id: number): Listing | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM listings WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToListing(row) : null;
}

export function getListingCount(status?: string | string[]): number {
  const db = getDb();
  let sql = 'SELECT COUNT(*) as count FROM listings WHERE 1=1';
  const params: unknown[] = [];

  if (status) {
    const statuses = Array.isArray(status) ? status : [status];
    sql += ` AND status IN (${statuses.map(() => '?').join(', ')})`;
    params.push(...statuses);
  }

  const row = db.prepare(sql).get(...params) as { count: number };
  return row.count;
}

export function getCostBreakdown(listingId: number): CostBreakdown | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM cost_breakdown WHERE listingId = ?').get(listingId) as Record<string, unknown> | undefined;

  if (!row) return null;

  return {
    listingId: row.listingId as number,
    askingPrice: row.askingPrice as number | null,
    negotiatedPrice: row.negotiatedPrice as number | null,
    estimatedFinalPrice: row.estimatedFinalPrice as number | null,
    fees: parseJsonField<Record<string, number>>(row.fees as string | null),
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

export function getAuditLog(listingId: number): AuditEntry[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, listingId, action, fromState, toState, description, reasoning, triggeredBy, createdAt
    FROM audit_log WHERE listingId = ? ORDER BY createdAt DESC
  `).all(listingId) as AuditEntry[];
  return rows;
}

export function getEmails(listingId: number): Email[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM emails WHERE listingId = ? ORDER BY createdAt ASC
  `).all(listingId) as Email[];
  return rows;
}

export function getPendingApprovals(): PendingApproval[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM approval_queue
    WHERE status = 'pending'
    AND (expiresAt IS NULL OR expiresAt > datetime('now'))
    ORDER BY createdAt ASC
  `).all() as Array<Record<string, unknown>>;

  return rows.map(row => ({
    id: row.id as number,
    listingId: row.listingId as number | null,
    actionType: row.actionType as string,
    description: row.description as string,
    reasoning: row.reasoning as string | null,
    payload: parseJsonField<Record<string, unknown>>(row.payload as string) || {},
    checkpointType: row.checkpointType as string | null,
    thresholdValue: row.thresholdValue as string | null,
    createdAt: row.createdAt as string,
    expiresAt: row.expiresAt as string | null,
  }));
}

export function getApprovalStats(): { pending: number; approved: number; rejected: number; expired: number } {
  const db = getDb();
  const row = db.prepare(`
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

export function approveAction(id: number, notes?: string): { success: boolean; error?: string } {
  const db = getDb();

  const row = db.prepare('SELECT * FROM approval_queue WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return { success: false, error: 'Approval not found' };
  if (row.status !== 'pending') return { success: false, error: `Approval already ${row.status}` };

  db.prepare(`
    UPDATE approval_queue
    SET status = 'approved', resolvedBy = 'user', resolvedAt = datetime('now'), resolutionNotes = ?
    WHERE id = ?
  `).run(notes || null, id);

  return { success: true };
}

export function rejectAction(id: number, notes?: string): { success: boolean; error?: string } {
  const db = getDb();

  const row = db.prepare('SELECT * FROM approval_queue WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return { success: false, error: 'Approval not found' };
  if (row.status !== 'pending') return { success: false, error: `Approval already ${row.status}` };

  db.prepare(`
    UPDATE approval_queue
    SET status = 'rejected', resolvedBy = 'user', resolvedAt = datetime('now'), resolutionNotes = ?
    WHERE id = ?
  `).run(notes || null, id);

  return { success: true };
}

export function getDashboardStats(): {
  total: number;
  byStatus: Record<string, number>;
  totalExposure: number;
  needsFollowUp: number;
  highReadiness: number;
} {
  const db = getDb();

  // Total count
  const totalRow = db.prepare('SELECT COUNT(*) as count FROM listings').get() as { count: number };

  // Count by status
  const statusRows = db.prepare(`
    SELECT status, COUNT(*) as count FROM listings GROUP BY status
  `).all() as Array<{ status: string; count: number }>;

  const byStatus: Record<string, number> = {};
  for (const row of statusRows) {
    byStatus[row.status] = row.count;
  }

  // Total exposure (sum of prices for active negotiations)
  const exposureRow = db.prepare(`
    SELECT COALESCE(SUM(price), 0) as total FROM listings
    WHERE status IN ('negotiating', 'viewing_scheduled', 'inspected', 'offer_made')
  `).get() as { total: number };

  // Needs follow-up (contacted but no response in 2+ days)
  const followUpRow = db.prepare(`
    SELECT COUNT(*) as count FROM listings
    WHERE status IN ('contacted', 'awaiting_response')
    AND lastContactedAt IS NOT NULL
    AND lastContactedAt < datetime('now', '-2 days')
    AND (lastSellerResponseAt IS NULL OR lastSellerResponseAt < lastContactedAt)
  `).get() as { count: number };

  // High readiness
  const readinessRow = db.prepare(`
    SELECT COUNT(*) as count FROM listings WHERE readinessScore >= 80
  `).get() as { count: number };

  return {
    total: totalRow.count,
    byStatus,
    totalExposure: exposureRow.total,
    needsFollowUp: followUpRow.count,
    highReadiness: readinessRow.count,
  };
}

export function updateListing(id: number, updates: Partial<Listing>): void {
  const db = getDb();

  const allowedFields = [
    'status', 'notes', 'readinessScore', 'priceNegotiated', 'negotiatedPrice',
  ];

  const fieldsToUpdate = Object.keys(updates).filter(k => allowedFields.includes(k));
  if (fieldsToUpdate.length === 0) return;

  const setClause = fieldsToUpdate.map(f => `${f} = ?`).join(', ');
  const values = fieldsToUpdate.map(f => (updates as Record<string, unknown>)[f]);

  db.prepare(`UPDATE listings SET ${setClause}, updatedAt = datetime('now') WHERE id = ?`).run(...values, id);
}

export function addAuditEntry(
  listingId: number | null,
  action: string,
  fromState: string | null,
  toState: string | null,
  description: string | null
): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO audit_log (listingId, action, fromState, toState, description, triggeredBy, createdAt)
    VALUES (?, ?, ?, ?, ?, 'web_ui', datetime('now'))
  `).run(listingId, action, fromState, toState, description);
}
