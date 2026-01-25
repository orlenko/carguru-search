import Imap from 'imap';
import { simpleParser, ParsedMail } from 'mailparser';
import nodemailer from 'nodemailer';
import { getEnv } from '../config.js';

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

  constructor(config?: Partial<EmailConfig>) {
    this.config = {
      user: config?.user || getEnv('EMAIL_USER'),
      password: config?.password || getEnv('EMAIL_PASSWORD'),
      imap: config?.imap || DEFAULT_CONFIG.imap,
      smtp: config?.smtp || DEFAULT_CONFIG.smtp,
    };
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
   */
  async fetchNewEmails(since?: Date): Promise<IncomingEmail[]> {
    return new Promise((resolve, reject) => {
      const imap = new Imap({
        user: this.config.user,
        password: this.config.password,
        host: this.config.imap.host,
        port: this.config.imap.port,
        tls: this.config.imap.tls,
        tlsOptions: { rejectUnauthorized: false },
      });

      const emails: IncomingEmail[] = [];

      imap.once('ready', () => {
        imap.openBox('INBOX', false, (err, box) => {
          if (err) {
            imap.end();
            reject(err);
            return;
          }

          // Search for unseen emails, optionally since a date
          const searchCriteria: any[] = ['UNSEEN'];
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
        tlsOptions: { rejectUnauthorized: false },
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
