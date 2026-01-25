import Database from 'better-sqlite3';
import { SCHEMA, type ListingStatus } from './schema.js';
import path from 'path';

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
  notes: string | null;
  discoveredAt: string;
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
        features, photoUrls
      ) VALUES (
        @source, @sourceId, @sourceUrl, @vin, @year, @make, @model, @trim,
        @mileageKm, @price, @sellerType, @sellerName, @sellerPhone, @sellerEmail,
        @dealerRating, @city, @province, @postalCode, @distanceKm, @description,
        @features, @photoUrls
      )
      ON CONFLICT(source, sourceId) DO UPDATE SET
        sourceUrl = excluded.sourceUrl,
        vin = COALESCE(excluded.vin, vin),
        mileageKm = COALESCE(excluded.mileageKm, mileageKm),
        price = COALESCE(excluded.price, price),
        sellerPhone = COALESCE(excluded.sellerPhone, sellerPhone),
        sellerEmail = COALESCE(excluded.sellerEmail, sellerEmail),
        dealerRating = COALESCE(excluded.dealerRating, dealerRating),
        description = COALESCE(excluded.description, description),
        features = COALESCE(excluded.features, features),
        photoUrls = COALESCE(excluded.photoUrls, photoUrls),
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
      'status', 'score', 'redFlags', 'aiAnalysis', 'carfaxReceived', 'carfaxPath',
      'accidentCount', 'ownerCount', 'serviceRecordCount', 'carfaxSummary',
      'lastContactedAt', 'contactAttempts', 'notes', 'vin', 'price', 'mileageKm',
      'sellerPhone', 'sellerEmail',
    ];

    const fieldsToUpdate: string[] = [];
    const values: unknown[] = [];

    for (const [key, value] of Object.entries(updates)) {
      if (allowedFields.includes(key)) {
        fieldsToUpdate.push(`${key} = ?`);
        if (key === 'redFlags' && Array.isArray(value)) {
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
      carfaxReceived: Boolean(row.carfaxReceived),
    } as Listing;
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
