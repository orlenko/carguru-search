import Imap from 'imap';
import { simpleParser, ParsedMail } from 'mailparser';
import nodemailer from 'nodemailer';
import { getEnv } from '../config.js';
import * as fs from 'fs';
import * as path from 'path';
import { getDatabase, type NewEmailAttachment } from '../database/index.js';

export interface EmailConfig {
  user: string;
  password: string;
  imap: {
    host: string;
    port: number;
    tls: boolean;
  };
  smtp: {
    host: string;
    port: number;
    secure: boolean;
  };
}

export interface IncomingEmail {
  id: string;
  messageId: string | null;  // RFC Message-ID header for deduplication
  from: string;
  to: string;
  subject: string;
  date: Date;
  text: string;
  html: string | null;
  attachments: Array<{
    filename: string;
    contentType: string;
    content: Buffer;
  }>;
}

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: Array<{
    filename: string;
    content: Buffer | string;
    contentType?: string;
  }>;
}

const DEFAULT_CONFIG: Omit<EmailConfig, 'user' | 'password'> = {
  imap: {
    host: 'imap.gmail.com',
    port: 993,
    tls: true,
  },
  smtp: {
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
  },
};

export class EmailClient {
  private config: EmailConfig;
  private transporter: nodemailer.Transporter | null = null;
  private allowSelfSigned: boolean;

  constructor(config?: Partial<EmailConfig>) {
    this.config = {
      user: config?.user || getEnv('EMAIL_USER'),
      password: config?.password || getEnv('EMAIL_PASSWORD'),
      imap: config?.imap || DEFAULT_CONFIG.imap,
      smtp: config?.smtp || DEFAULT_CONFIG.smtp,
    };
    this.allowSelfSigned = (getEnv('IMAP_ALLOW_SELF_SIGNED', false) || '').toLowerCase() === 'true';
  }

  /**
   * Send an email
   */
  async send(email: OutgoingEmail): Promise<string> {
    if (!this.transporter) {
      this.transporter = nodemailer.createTransport({
        host: this.config.smtp.host,
        port: this.config.smtp.port,
        secure: this.config.smtp.secure,
        auth: {
          user: this.config.user,
          pass: this.config.password,
        },
      });
    }

    const buyerName = getEnv('BUYER_NAME', false) || 'Car Buyer';

    const info = await this.transporter.sendMail({
      from: `"${buyerName}" <${this.config.user}>`,
      to: email.to,
      subject: email.subject,
      text: email.text,
      html: email.html,
      attachments: email.attachments,
    });

    return info.messageId;
  }

  /**
   * Fetch new emails from inbox
   * @param since - Only fetch emails since this date
   * @param includeRead - If true, also fetch read emails (not just UNSEEN)
   */
  async fetchNewEmails(since?: Date, includeRead: boolean = false): Promise<IncomingEmail[]> {
    return new Promise((resolve, reject) => {
      const imap = new Imap({
        user: this.config.user,
        password: this.config.password,
        host: this.config.imap.host,
        port: this.config.imap.port,
        tls: this.config.imap.tls,
        ...(this.allowSelfSigned ? { tlsOptions: { rejectUnauthorized: false } } : {}),
      });

      const emails: IncomingEmail[] = [];

      imap.once('ready', () => {
        imap.openBox('INBOX', false, (err, box) => {
          if (err) {
            imap.end();
            reject(err);
            return;
          }

          // Search for emails - either unseen only or all (if includeRead)
          const searchCriteria: any[] = includeRead ? ['ALL'] : ['UNSEEN'];
          if (since) {
            searchCriteria.push(['SINCE', since]);
          }

          imap.search(searchCriteria, (err, uids) => {
            if (err) {
              imap.end();
              reject(err);
              return;
            }

            if (uids.length === 0) {
              imap.end();
              resolve([]);
              return;
            }

            const fetch = imap.fetch(uids, {
              bodies: '',
              markSeen: true,
            });

            fetch.on('message', (msg, seqno) => {
              msg.on('body', (stream) => {
                simpleParser(stream as any, (err, parsed) => {
                  if (err) {
                    console.error('Failed to parse email:', err);
                    return;
                  }

                  emails.push(this.parsedMailToIncoming(parsed, seqno.toString()));
                });
              });
            });

            fetch.once('error', (err) => {
              imap.end();
              reject(err);
            });

            fetch.once('end', () => {
              imap.end();
            });
          });
        });
      });

      imap.once('error', reject);
      imap.once('end', () => {
        resolve(emails);
      });

      imap.connect();
    });
  }

  /**
   * Search emails by subject or sender
   */
  async searchEmails(query: {
    from?: string;
    subject?: string;
    since?: Date;
  }): Promise<IncomingEmail[]> {
    return new Promise((resolve, reject) => {
      const imap = new Imap({
        user: this.config.user,
        password: this.config.password,
        host: this.config.imap.host,
        port: this.config.imap.port,
        tls: this.config.imap.tls,
        ...(this.allowSelfSigned ? { tlsOptions: { rejectUnauthorized: false } } : {}),
      });

      const emails: IncomingEmail[] = [];

      imap.once('ready', () => {
        imap.openBox('INBOX', true, (err) => {
          if (err) {
            imap.end();
            reject(err);
            return;
          }

          const searchCriteria: any[] = ['ALL'];
          if (query.from) {
            searchCriteria.push(['FROM', query.from]);
          }
          if (query.subject) {
            searchCriteria.push(['SUBJECT', query.subject]);
          }
          if (query.since) {
            searchCriteria.push(['SINCE', query.since]);
          }

          imap.search(searchCriteria, (err, uids) => {
            if (err) {
              imap.end();
              reject(err);
              return;
            }

            if (uids.length === 0) {
              imap.end();
              resolve([]);
              return;
            }

            // Limit to last 50 results
            const recentUids = uids.slice(-50);

            const fetch = imap.fetch(recentUids, {
              bodies: '',
            });

            fetch.on('message', (msg, seqno) => {
              msg.on('body', (stream) => {
                simpleParser(stream as any, (err, parsed) => {
                  if (err) {
                    console.error('Failed to parse email:', err);
                    return;
                  }

                  emails.push(this.parsedMailToIncoming(parsed, seqno.toString()));
                });
              });
            });

            fetch.once('error', (err) => {
              imap.end();
              reject(err);
            });

            fetch.once('end', () => {
              imap.end();
            });
          });
        });
      });

      imap.once('error', reject);
      imap.once('end', () => {
        resolve(emails);
      });

      imap.connect();
    });
  }

  private parsedMailToIncoming(parsed: ParsedMail, id: string): IncomingEmail {
    // Handle AddressObject which can be single or array
    const fromText = parsed.from
      ? (Array.isArray(parsed.from) ? parsed.from[0]?.text : parsed.from.text) || ''
      : '';
    const toText = parsed.to
      ? (Array.isArray(parsed.to) ? parsed.to[0]?.text : parsed.to.text) || ''
      : '';

    return {
      id,
      messageId: parsed.messageId || null,  // RFC Message-ID for deduplication
      from: fromText,
      to: toText,
      subject: parsed.subject || '',
      date: parsed.date || new Date(),
      text: parsed.text || '',
      html: parsed.html || null,
      attachments: (parsed.attachments || []).map(att => ({
        filename: att.filename || 'attachment',
        contentType: att.contentType,
        content: att.content,
      })),
    };
  }

  /**
   * Close any open connections
   */
  close(): void {
    if (this.transporter) {
      this.transporter.close();
      this.transporter = null;
    }
  }
}

/**
 * Attachment type classification based on filename and content type
 */
export type AttachmentType = 'carfax' | 'photo' | 'document' | 'other';

/**
 * Check if an attachment is likely irrelevant (signature, logo, marketing)
 */
export function isIrrelevantAttachment(filename: string, contentType: string, sizeBytes: number): boolean {
  const lowerFilename = filename.toLowerCase();

  // Skip very small images (likely signatures/logos)
  if (contentType.startsWith('image/') && sizeBytes < 10000) {
    return true;
  }

  // Skip common signature/logo patterns
  const irrelevantPatterns = [
    'signature',
    'logo',
    'banner',
    'footer',
    'header',
    'spacer',
    'pixel',
    'tracking',
    'unsubscribe',
    'email_sig',
    'emailsig',
    'sig_',
    '_sig',
    'icon',
  ];

  for (const pattern of irrelevantPatterns) {
    if (lowerFilename.includes(pattern)) {
      return true;
    }
  }

  // Skip marketing image dimensions patterns (e.g., 600x100.png)
  if (/\d+x\d+\.(png|jpg|gif)$/i.test(lowerFilename)) {
    return true;
  }

  return false;
}

/**
 * Classify attachment type based on filename and content type
 */
export function classifyAttachment(filename: string, contentType: string): AttachmentType {
  const lowerFilename = filename.toLowerCase();

  // CARFAX detection
  if (lowerFilename.includes('carfax') || lowerFilename.includes('car_fax') || lowerFilename.includes('vehicle_history')) {
    return 'carfax';
  }

  // PDF documents
  if (contentType === 'application/pdf' || lowerFilename.endsWith('.pdf')) {
    // Could be CARFAX, inspection report, etc.
    if (lowerFilename.includes('report') || lowerFilename.includes('inspection') || lowerFilename.includes('history')) {
      return 'document';
    }
    return 'document';
  }

  // Images
  if (contentType.startsWith('image/') || /\.(jpg|jpeg|png|gif|webp|heic)$/i.test(lowerFilename)) {
    return 'photo';
  }

  // Other document types
  if (/\.(doc|docx|xls|xlsx|txt)$/i.test(lowerFilename)) {
    return 'document';
  }

  return 'other';
}

/**
 * Save attachments from an email to disk and record in database
 */
export async function saveEmailAttachments(
  email: IncomingEmail,
  listingId: number,
  emailId?: number
): Promise<Array<{ filename: string; path: string; type: AttachmentType }>> {
  const db = getDatabase();
  const savedAttachments: Array<{ filename: string; path: string; type: AttachmentType }> = [];

  if (!email.attachments || email.attachments.length === 0) {
    return savedAttachments;
  }

  // Create attachments directory
  const attachmentsDir = path.join('data', 'attachments', listingId.toString());
  fs.mkdirSync(attachmentsDir, { recursive: true });

  for (const attachment of email.attachments) {
    const sizeBytes = attachment.content.length;
    const isRelevant = !isIrrelevantAttachment(attachment.filename, attachment.contentType, sizeBytes);

    if (!isRelevant) {
      continue; // Skip irrelevant attachments
    }

    const attachmentType = classifyAttachment(attachment.filename, attachment.contentType);

    // Generate unique filename to avoid conflicts
    let filename = attachment.filename;
    let filePath = path.join(attachmentsDir, filename);
    let counter = 1;

    while (fs.existsSync(filePath)) {
      const ext = path.extname(filename);
      const base = path.basename(filename, ext);
      filename = `${base}_${counter}${ext}`;
      filePath = path.join(attachmentsDir, filename);
      counter++;
    }

    // Save file to disk
    fs.writeFileSync(filePath, attachment.content);

    // Record in database
    const newAttachment: NewEmailAttachment = {
      listingId,
      emailId,
      filename,
      originalFilename: attachment.filename,
      filePath,
      mimeType: attachment.contentType,
      sizeBytes,
      attachmentType,
      isRelevant: true,
    };

    db.saveAttachment(newAttachment);

    savedAttachments.push({
      filename,
      path: filePath,
      type: attachmentType,
    });
  }

  return savedAttachments;
}

/**
 * Extract seller contact from email for matching with listings
 */
export function extractSenderEmail(email: IncomingEmail): string | null {
  // Extract email address from "Name <email@example.com>" format
  const match = email.from.match(/<([^>]+)>/);
  if (match) {
    return match[1].toLowerCase();
  }
  // If no angle brackets, assume it's just an email
  if (email.from.includes('@')) {
    return email.from.toLowerCase().trim();
  }
  return null;
}
