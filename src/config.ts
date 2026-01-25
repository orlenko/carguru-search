import { readFileSync, existsSync } from 'fs';
import { parse } from 'yaml';
import { z } from 'zod';
import path from 'path';
import { config as loadDotenv } from 'dotenv';

// Load .env file
loadDotenv();

const SearchConfigSchema = z.object({
  make: z.string(),
  model: z.string(),
  yearMin: z.number().optional(),
  yearMax: z.number().optional(),
  mileageMax: z.number().optional(),
  priceMax: z.number().optional(),
  postalCode: z.string(),
  radiusKm: z.number().default(100),
  sites: z.array(z.string()).default(['cargurus']),
});

const ScoringConfigSchema = z.object({
  weights: z.object({
    price: z.number().default(0.25),
    mileage: z.number().default(0.25),
    accidentHistory: z.number().default(0.20),
    ownerCount: z.number().default(0.10),
    serviceRecords: z.number().default(0.10),
    dealerRating: z.number().default(0.10),
  }),
  dealBreakers: z.array(z.string()).default([]),
  preferences: z.object({
    preferPrivateSeller: z.boolean().default(false),
    preferCertified: z.boolean().default(false),
    maxOwners: z.number().default(3),
  }).default({}),
});

const EmailConfigSchema = z.object({
  fromName: z.string(),
  fromEmail: z.string().email(),
  imap: z.object({
    host: z.string(),
    port: z.number(),
    secure: z.boolean().default(true),
  }),
  smtp: z.object({
    host: z.string(),
    port: z.number(),
    secure: z.boolean().default(false),
  }),
}).optional();

const ConfigSchema = z.object({
  search: SearchConfigSchema,
  scoring: ScoringConfigSchema.default({
    weights: {
      price: 0.25,
      mileage: 0.25,
      accidentHistory: 0.20,
      ownerCount: 0.10,
      serviceRecords: 0.10,
      dealerRating: 0.10,
    },
    dealBreakers: [],
    preferences: {},
  }),
  email: EmailConfigSchema,
  privateNotes: z.string().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;
export type SearchConfig = z.infer<typeof SearchConfigSchema>;
export type ScoringConfig = z.infer<typeof ScoringConfigSchema>;

let cachedConfig: Config | null = null;

export function loadConfig(): Config {
  if (cachedConfig) return cachedConfig;

  const configPath = path.resolve('./config/config.local.yaml');

  if (!existsSync(configPath)) {
    throw new Error(
      `Config file not found at ${configPath}\n` +
      `Please copy config/config.example.yaml to config/config.local.yaml and fill in your preferences.`
    );
  }

  const rawConfig = readFileSync(configPath, 'utf-8');
  const parsed = parse(rawConfig);

  cachedConfig = ConfigSchema.parse(parsed);
  return cachedConfig;
}

export function getEnv(key: string, required = true): string {
  const value = process.env[key];
  if (!value && required) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value || '';
}

export function getAnthropicApiKey(): string {
  return getEnv('ANTHROPIC_API_KEY');
}

export function getEmailCredentials(): { user: string; password: string } {
  return {
    user: getEnv('EMAIL_USER'),
    password: getEnv('EMAIL_PASSWORD'),
  };
}
