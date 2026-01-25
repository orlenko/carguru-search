import { getEnv } from '../config.js';

// We'll use Twilio's REST API directly to avoid the heavy SDK
// This keeps the dependency lightweight

export interface SmsConfig {
  accountSid: string;
  authToken: string;
  fromNumber: string;
}

export interface SmsMessage {
  to: string;
  body: string;
}

export interface IncomingSms {
  from: string;
  to: string;
  body: string;
  dateSent: Date;
  sid: string;
}

export class SmsClient {
  private config: SmsConfig;
  private baseUrl: string;

  constructor(config?: Partial<SmsConfig>) {
    this.config = {
      accountSid: config?.accountSid || getEnv('TWILIO_ACCOUNT_SID'),
      authToken: config?.authToken || getEnv('TWILIO_AUTH_TOKEN'),
      fromNumber: config?.fromNumber || getEnv('TWILIO_PHONE_NUMBER'),
    };
    this.baseUrl = `https://api.twilio.com/2010-04-01/Accounts/${this.config.accountSid}`;
  }

  /**
   * Send an SMS message
   */
  async send(message: SmsMessage): Promise<string> {
    const url = `${this.baseUrl}/Messages.json`;

    const body = new URLSearchParams({
      To: this.normalizePhone(message.to),
      From: this.config.fromNumber,
      Body: message.body,
    });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${this.config.accountSid}:${this.config.authToken}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    if (!response.ok) {
      const error = await response.json() as { message?: string };
      throw new Error(`Failed to send SMS: ${error.message || response.statusText}`);
    }

    const result = await response.json() as { sid: string };
    return result.sid;
  }

  /**
   * Fetch recent incoming messages
   */
  async fetchIncoming(since?: Date, limit = 20): Promise<IncomingSms[]> {
    const params = new URLSearchParams({
      To: this.config.fromNumber,
      PageSize: limit.toString(),
    });

    if (since) {
      params.set('DateSent>', since.toISOString().split('T')[0]);
    }

    const url = `${this.baseUrl}/Messages.json?${params.toString()}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${this.config.accountSid}:${this.config.authToken}`).toString('base64'),
      },
    });

    if (!response.ok) {
      const error = await response.json() as { message?: string };
      throw new Error(`Failed to fetch messages: ${error.message || response.statusText}`);
    }

    const result = await response.json() as { messages?: any[] };

    return (result.messages || []).map((msg: any) => ({
      from: msg.from,
      to: msg.to,
      body: msg.body,
      dateSent: new Date(msg.date_sent),
      sid: msg.sid,
    }));
  }

  /**
   * Normalize phone number to E.164 format
   */
  private normalizePhone(phone: string): string {
    // Remove all non-digits
    const digits = phone.replace(/\D/g, '');

    // If 10 digits, assume North American and add +1
    if (digits.length === 10) {
      return `+1${digits}`;
    }

    // If 11 digits starting with 1, add +
    if (digits.length === 11 && digits.startsWith('1')) {
      return `+${digits}`;
    }

    // If already has country code, just add +
    if (digits.length > 10) {
      return `+${digits}`;
    }

    // Return as-is if we can't normalize
    return phone;
  }
}

/**
 * Generate SMS text for dealer contact
 */
export function generateSmsText(
  type: 'inquiry' | 'follow_up' | 'carfax_request',
  vehicleInfo: string,
  buyerName?: string
): string {
  const name = buyerName || getEnv('BUYER_NAME', false) || 'Buyer';

  switch (type) {
    case 'inquiry':
      return `Hi, I'm interested in the ${vehicleInfo}. Is it still available? - ${name}`;

    case 'follow_up':
      return `Hi, following up on the ${vehicleInfo}. Any updates? - ${name}`;

    case 'carfax_request':
      return `Hi, interested in the ${vehicleInfo}. Could you email me the CARFAX report? - ${name}`;

    default:
      throw new Error(`Unknown SMS type: ${type}`);
  }
}
