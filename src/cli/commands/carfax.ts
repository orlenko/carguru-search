import { Command } from 'commander';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { getDatabase } from '../../database/index.js';
import { analyzeCarfaxPdf, analyzeCarfaxBuffer } from '../../analyzers/carfax-analyzer.js';
import type { CarfaxAnalysis } from '../../analyzers/carfax-analyzer.js';

export const carfaxCommand = new Command('carfax')
  .description('Analyze a CARFAX PDF report')
  .argument('<path>', 'Path to CARFAX PDF file')
  .option('-l, --listing <id>', 'Associate with a listing ID')
  .option('--json', 'Output raw JSON')
  .action(async (pdfPath, options) => {
    try {
      if (!existsSync(pdfPath)) {
        console.error(`File not found: ${pdfPath}`);
        process.exit(1);
      }

      console.log('\n📄 Analyzing CARFAX report...\n');

      const analysis = await analyzeCarfaxPdf(pdfPath);

      if (options.json) {
        console.log(JSON.stringify(analysis, null, 2));
        return;
      }

      printCarfaxAnalysis(analysis);

      // Associate with listing if specified
      if (options.listing) {
        const db = getDatabase();
        const listingId = parseInt(options.listing, 10);
        const listing = db.getListing(listingId);

        if (listing) {
          db.updateListing(listingId, {
            notes: `${listing.notes || ''}\n\nCARFAX Analysis (${new Date().toISOString()}):\nRisk: ${analysis.riskLevel}\nSummary: ${analysis.summary}`.trim(),
          });
          console.log(`\n📎 Analysis saved to listing #${listingId}`);
        } else {
          console.error(`\nListing #${options.listing} not found.`);
        }
      }
    } catch (error) {
      console.error('Failed to analyze CARFAX:', error);
      process.exit(1);
    }
  });

export const scanCarfaxCommand = new Command('scan-carfax')
  .description('Scan a directory for CARFAX PDFs and analyze them')
  .argument('<directory>', 'Directory to scan')
  .option('--match <pattern>', 'Filename pattern to match (default: carfax)', 'carfax')
  .action(async (directory, options) => {
    try {
      if (!existsSync(directory)) {
        console.error(`Directory not found: ${directory}`);
        process.exit(1);
      }

      const files = readdirSync(directory).filter(
        f => f.toLowerCase().endsWith('.pdf') &&
             f.toLowerCase().includes(options.match.toLowerCase())
      );

      if (files.length === 0) {
        console.log(`No CARFAX PDFs found in ${directory}`);
        return;
      }

      console.log(`\n📂 Found ${files.length} CARFAX PDF(s)\n`);

      for (const file of files) {
        console.log('─'.repeat(60));
        console.log(`📄 ${file}\n`);

        try {
          const analysis = await analyzeCarfaxPdf(join(directory, file));
          printCarfaxAnalysis(analysis);
        } catch (error) {
          console.error(`  Failed to analyze: ${error}`);
        }

        console.log('');
      }
    } catch (error) {
      console.error('Failed to scan directory:', error);
      process.exit(1);
    }
  });

function printCarfaxAnalysis(analysis: CarfaxAnalysis): void {
  const riskColors: Record<string, string> = {
    'severe': '🔴',
    'high': '🟠',
    'medium': '🟡',
    'low': '🟢',
  };

  console.log(`${riskColors[analysis.riskLevel]} Risk Level: ${analysis.riskLevel.toUpperCase()}`);
  console.log('');

  if (analysis.data.vin) {
    console.log(`VIN: ${analysis.data.vin}`);
  }
  if (analysis.data.ownerCount !== null) {
    console.log(`Owners: ${analysis.data.ownerCount}`);
  }
  console.log(`Accidents: ${analysis.data.accidentCount}`);
  console.log(`Service Records: ${analysis.data.serviceRecordCount}`);

  // Key warnings
  const warnings: string[] = [];
  if (analysis.data.structuralDamage) warnings.push('⚠️  STRUCTURAL DAMAGE');
  if (analysis.data.airbagDeployed) warnings.push('⚠️  AIRBAG DEPLOYED');
  if (analysis.data.floodDamage) warnings.push('⚠️  FLOOD DAMAGE');
  if (analysis.data.frameDamage) warnings.push('⚠️  FRAME DAMAGE');
  if (analysis.data.totalLoss) warnings.push('⚠️  TOTAL LOSS/SALVAGE');
  if (analysis.data.lemonHistory) warnings.push('⚠️  LEMON BUYBACK');

  if (warnings.length > 0) {
    console.log('\n' + warnings.join('\n'));
  }

  // Other notes
  const notes: string[] = [];
  if (analysis.data.commercialUse) notes.push('Commercial/fleet use');
  if (analysis.data.rentalHistory) notes.push('Rental history');
  if (analysis.data.titleIssues.length > 0) notes.push(`Title: ${analysis.data.titleIssues.join(', ')}`);

  if (notes.length > 0) {
    console.log('\nNotes: ' + notes.join(' | '));
  }

  console.log('\n📋 Summary:');
  console.log(analysis.summary);

  if (analysis.riskFactors.length > 0) {
    console.log('\n⚠️  Risk Factors:');
    analysis.riskFactors.forEach(f => console.log(`  • ${f}`));
  }

  if (analysis.recommendations.length > 0) {
    console.log('\n💡 Recommendations:');
    analysis.recommendations.forEach(r => console.log(`  • ${r}`));
  }
}
