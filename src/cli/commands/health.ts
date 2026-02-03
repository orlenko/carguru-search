import { Command } from 'commander';
import { existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { loadConfig } from '../../config.js';
import { getDatabase } from '../../database/index.js';

type CheckResult = {
  label: string;
  status: 'ok' | 'warn' | 'error';
  detail: string;
};

function printResult(result: CheckResult): void {
  const icon = result.status === 'ok' ? '✅' : result.status === 'warn' ? '⚠️' : '❌';
  console.log(`${icon} ${result.label}: ${result.detail}`);
}

export const healthCommand = new Command('health')
  .description('Check system readiness for automation')
  .option('--verbose', 'Show extra details')
  .action(async (options) => {
    const results: CheckResult[] = [];
    let hasError = false;

    // Config check
    try {
      const config = loadConfig();
      results.push({
        label: 'Config',
        status: 'ok',
        detail: `Loaded config for ${config.search.make} ${config.search.model}`,
      });
    } catch (error) {
      results.push({
        label: 'Config',
        status: 'error',
        detail: error instanceof Error ? error.message : 'Failed to load config',
      });
      hasError = true;
    }

    // Env check
    const requiredEnv = ['EMAIL_USER', 'EMAIL_PASSWORD', 'BUYER_NAME'];
    const missingEnv = requiredEnv.filter((key) => !process.env[key]);
    if (missingEnv.length > 0) {
      results.push({
        label: 'Environment',
        status: 'error',
        detail: `Missing: ${missingEnv.join(', ')}`,
      });
      hasError = true;
    } else {
      results.push({
        label: 'Environment',
        status: 'ok',
        detail: 'Required variables present',
      });
    }

    // Claude CLI check
    const claude = spawnSync('claude', ['--version'], { stdio: 'ignore' });
    if (claude.error || claude.status !== 0) {
      results.push({
        label: 'Claude CLI',
        status: 'warn',
        detail: 'Not found or not executable (AI analysis will fail)',
      });
    } else {
      results.push({
        label: 'Claude CLI',
        status: 'ok',
        detail: 'Available',
      });
    }

    // Playwright check
    try {
      const playwright = await import('playwright');
      const executablePath = playwright.chromium.executablePath();
      if (!existsSync(executablePath)) {
        results.push({
          label: 'Playwright',
          status: 'error',
          detail: 'Chromium not installed. Run: npx playwright install chromium',
        });
        hasError = true;
      } else {
        results.push({
          label: 'Playwright',
          status: 'ok',
          detail: 'Chromium available',
        });
      }
    } catch (error) {
      results.push({
        label: 'Playwright',
        status: 'error',
        detail: 'Playwright not installed or failed to load',
      });
      hasError = true;
    }

    // Database check
    try {
      const db = getDatabase();
      const stats = db.getStats();
      results.push({
        label: 'Database',
        status: 'ok',
        detail: `Listings: ${stats.total}`,
      });
    } catch (error) {
      results.push({
        label: 'Database',
        status: 'error',
        detail: 'Failed to open database',
      });
      hasError = true;
    }

    console.log('\n🩺 Health Check\n');
    results.forEach(printResult);

    if (options.verbose) {
      console.log('\nNotes:');
      console.log('- Claude CLI is required for AI analysis and negotiation steps.');
      console.log('- Playwright Chromium is required for AutoTrader scraping and contact forms.');
    }

    if (hasError) {
      process.exit(1);
    }
  });
