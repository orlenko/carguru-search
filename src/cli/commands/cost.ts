/**
 * Cost Calculation Command - Calculate and export total cost breakdowns
 */
import { Command } from 'commander';
import { getDatabase } from '../../database/index.js';
import { loadConfig } from '../../config.js';
import { existsSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';

// Ontario HST rate
const HST_RATE = 0.13;

// Common dealer fees (CAD)
const DEFAULT_FEES = {
  adminFee: 499,        // Admin/documentation fee (typical dealer)
  omvicFee: 10,         // OMVIC fee (Ontario Motor Vehicle Industry Council)
  tireStewardship: 20,  // Tire stewardship fee
};

// Private sale has no dealer fees, just registration
const PRIVATE_SALE_FEES = {
  adminFee: 0,
  omvicFee: 0,
  tireStewardship: 0,
};

// Service Ontario registration (approximate)
const REGISTRATION_COST = 32;
const PLATE_TRANSFER_COST = 32;
const NEW_PLATE_COST = 59;

interface CostBreakdown {
  listingId: number;
  vehicle: string;
  askingPrice: number;
  negotiatedPrice: number | null;
  effectivePrice: number;
  sellerType: 'dealer' | 'private';
  fees: {
    adminFee: number;
    omvicFee: number;
    tireStewardship: number;
    otherFees: number;
    totalFees: number;
  };
  taxes: {
    taxableAmount: number;
    hstRate: number;
    hstAmount: number;
  };
  registration: {
    required: boolean;
    plateTransfer: boolean;
    cost: number;
  };
  totals: {
    subtotal: number;
    totalBeforeTax: number;
    totalTax: number;
    grandTotal: number;
  };
  budget: {
    amount: number;
    withinBudget: boolean;
    remaining: number;
  };
  calculatedAt: string;
}

function calculateCost(
  listing: {
    id: number;
    year: number;
    make: string;
    model: string;
    price: number | null;
    sellerType: string | null;
    negotiatedPrice?: number | null;
  },
  budget: number,
  options: {
    negotiatedPrice?: number;
    includeRegistration?: boolean;
    plateTransfer?: boolean;
    customFees?: Record<string, number>;
  } = {}
): CostBreakdown {
  const askingPrice = listing.price || 0;
  const negotiatedPrice = options.negotiatedPrice ?? listing.negotiatedPrice ?? null;
  const effectivePrice = negotiatedPrice || askingPrice;
  const sellerType = (listing.sellerType?.toLowerCase() === 'private' ? 'private' : 'dealer') as 'dealer' | 'private';

  // Base fees depend on seller type
  const baseFees = sellerType === 'private' ? PRIVATE_SALE_FEES : DEFAULT_FEES;
  const fees = {
    adminFee: options.customFees?.adminFee ?? baseFees.adminFee,
    omvicFee: options.customFees?.omvicFee ?? baseFees.omvicFee,
    tireStewardship: options.customFees?.tireStewardship ?? baseFees.tireStewardship,
    otherFees: options.customFees?.otherFees ?? 0,
    totalFees: 0,
  };
  fees.totalFees = fees.adminFee + fees.omvicFee + fees.tireStewardship + fees.otherFees;

  // Registration
  const includeRegistration = options.includeRegistration ?? true;
  const plateTransfer = options.plateTransfer ?? true;
  const registrationCost = includeRegistration
    ? (plateTransfer ? PLATE_TRANSFER_COST : NEW_PLATE_COST) + REGISTRATION_COST
    : 0;

  // Tax calculation
  // In Ontario, HST applies to the purchase price and most fees
  const taxableAmount = effectivePrice + fees.adminFee + fees.tireStewardship;
  const hstAmount = Math.round(taxableAmount * HST_RATE);

  // Totals
  const subtotal = effectivePrice;
  const totalBeforeTax = effectivePrice + fees.totalFees;
  const totalTax = hstAmount;
  const grandTotal = totalBeforeTax + totalTax + registrationCost;

  // Budget check
  const withinBudget = grandTotal <= budget;
  const remaining = budget - grandTotal;

  return {
    listingId: listing.id,
    vehicle: `${listing.year} ${listing.make} ${listing.model}`,
    askingPrice,
    negotiatedPrice,
    effectivePrice,
    sellerType,
    fees,
    taxes: {
      taxableAmount,
      hstRate: HST_RATE,
      hstAmount,
    },
    registration: {
      required: includeRegistration,
      plateTransfer,
      cost: registrationCost,
    },
    totals: {
      subtotal,
      totalBeforeTax,
      totalTax,
      grandTotal,
    },
    budget: {
      amount: budget,
      withinBudget,
      remaining,
    },
    calculatedAt: new Date().toISOString(),
  };
}

export const costCommand = new Command('cost')
  .description('Calculate total cost breakdown for a listing')
  .argument('<id>', 'Listing ID to calculate cost for')
  .option('--negotiated <price>', 'Use negotiated price instead of asking price')
  .option('--admin-fee <amount>', 'Override admin fee (default: $499 for dealers)')
  .option('--no-registration', 'Exclude registration cost')
  .option('--new-plates', 'Calculate with new plates instead of plate transfer')
  .option('--export', 'Export to workspace JSON file')
  .action(async (id, options) => {
    const db = getDatabase();
    const config = loadConfig();
    const listingId = parseInt(id, 10);

    if (isNaN(listingId)) {
      console.error('Error: Invalid listing ID');
      process.exit(1);
    }

    const listing = db.getListing(listingId);
    if (!listing) {
      console.error(`Error: Listing #${listingId} not found`);
      process.exit(1);
    }

    const budget = config.search.priceMax || 20000;

    // Build options
    const calcOptions: Parameters<typeof calculateCost>[2] = {
      includeRegistration: options.registration !== false,
      plateTransfer: !options.newPlates,
    };

    if (options.negotiated) {
      calcOptions.negotiatedPrice = parseInt(options.negotiated, 10);
    }

    if (options.adminFee) {
      calcOptions.customFees = {
        ...DEFAULT_FEES,
        adminFee: parseInt(options.adminFee, 10),
      };
    }

    const cost = calculateCost(listing as any, budget, calcOptions);

    // Save to database
    db.saveCostBreakdown(listing.id, {
      askingPrice: cost.askingPrice,
      negotiatedPrice: cost.negotiatedPrice || undefined,
      estimatedFinalPrice: cost.effectivePrice,
      fees: cost.fees,
      taxRate: cost.taxes.hstRate,
      taxAmount: cost.taxes.hstAmount,
      registrationIncluded: cost.registration.required,
      registrationCost: cost.registration.cost,
      totalEstimatedCost: cost.totals.grandTotal,
      budget: cost.budget.amount,
    });

    // Print breakdown
    console.log('\n💰 Cost Breakdown');
    console.log('═'.repeat(50));
    console.log(`Listing #${listing.id}: ${cost.vehicle}`);
    console.log(`Seller Type: ${cost.sellerType === 'dealer' ? 'Dealer' : 'Private Sale'}`);
    console.log('─'.repeat(50));

    console.log('\nPricing:');
    console.log(`  Asking Price:         $${cost.askingPrice.toLocaleString()}`);
    if (cost.negotiatedPrice) {
      console.log(`  Negotiated Price:     $${cost.negotiatedPrice.toLocaleString()}`);
    }
    console.log(`  Effective Price:      $${cost.effectivePrice.toLocaleString()}`);

    if (cost.fees.totalFees > 0) {
      console.log('\nFees:');
      if (cost.fees.adminFee > 0) {
        console.log(`  Admin/Documentation:  $${cost.fees.adminFee.toLocaleString()}`);
      }
      if (cost.fees.omvicFee > 0) {
        console.log(`  OMVIC Fee:            $${cost.fees.omvicFee.toLocaleString()}`);
      }
      if (cost.fees.tireStewardship > 0) {
        console.log(`  Tire Stewardship:     $${cost.fees.tireStewardship.toLocaleString()}`);
      }
      if (cost.fees.otherFees > 0) {
        console.log(`  Other Fees:           $${cost.fees.otherFees.toLocaleString()}`);
      }
      console.log(`  Total Fees:           $${cost.fees.totalFees.toLocaleString()}`);
    }

    console.log('\nTaxes:');
    console.log(`  Taxable Amount:       $${cost.taxes.taxableAmount.toLocaleString()}`);
    console.log(`  HST (${(cost.taxes.hstRate * 100).toFixed(0)}%):            $${cost.taxes.hstAmount.toLocaleString()}`);

    if (cost.registration.required) {
      console.log('\nRegistration:');
      console.log(`  ${cost.registration.plateTransfer ? 'Plate Transfer' : 'New Plates'}:         $${cost.registration.cost.toLocaleString()}`);
    }

    console.log('\n' + '─'.repeat(50));
    console.log(`TOTAL OUT-THE-DOOR:     $${cost.totals.grandTotal.toLocaleString()}`);
    console.log('─'.repeat(50));

    console.log('\nBudget:');
    console.log(`  Budget:               $${cost.budget.amount.toLocaleString()}`);
    console.log(`  Within Budget:        ${cost.budget.withinBudget ? '✅ Yes' : '❌ No'}`);
    console.log(`  Remaining:            $${cost.budget.remaining.toLocaleString()}`);

    console.log('');

    // Export to workspace if requested
    if (options.export) {
      const workspacePath = path.resolve('./workspace/listings', `${listing.id}-${listing.year}-${listing.make}-${listing.model}`.toLowerCase().replace(/\s+/g, '-'));
      if (!existsSync(workspacePath)) {
        mkdirSync(workspacePath, { recursive: true });
      }

      const exportPath = path.join(workspacePath, 'cost.json');
      writeFileSync(exportPath, JSON.stringify(cost, null, 2));
      console.log(`📁 Exported to ${exportPath}\n`);
    }
  });

/**
 * Batch cost calculation
 */
export const costAllCommand = new Command('cost-all')
  .description('Calculate cost breakdown for all listings')
  .option('-s, --status <status>', 'Filter by status', 'analyzed,contacted,awaiting_response,negotiating')
  .option('--export', 'Export all to workspace JSON files')
  .action(async (options) => {
    const db = getDatabase();
    const config = loadConfig();
    const budget = config.search.priceMax || 20000;

    const statuses = options.status.split(',');
    const listings = db.listListings({ status: statuses as any, limit: 500 });

    console.log(`\nCalculating costs for ${listings.length} listings...\n`);

    let withinBudget = 0;
    let overBudget = 0;

    const results: Array<{
      id: number;
      vehicle: string;
      asking: number;
      total: number;
      fits: boolean;
    }> = [];

    for (const listing of listings) {
      const cost = calculateCost(listing as any, budget);

      // Save to database
      db.saveCostBreakdown(listing.id, {
        askingPrice: cost.askingPrice,
        estimatedFinalPrice: cost.effectivePrice,
        fees: cost.fees,
        taxRate: cost.taxes.hstRate,
        taxAmount: cost.taxes.hstAmount,
        registrationIncluded: cost.registration.required,
        registrationCost: cost.registration.cost,
        totalEstimatedCost: cost.totals.grandTotal,
        budget: cost.budget.amount,
      });

      results.push({
        id: listing.id,
        vehicle: cost.vehicle,
        asking: cost.askingPrice,
        total: cost.totals.grandTotal,
        fits: cost.budget.withinBudget,
      });

      if (cost.budget.withinBudget) {
        withinBudget++;
      } else {
        overBudget++;
      }

      // Export to workspace if requested
      if (options.export) {
        const workspacePath = path.resolve('./workspace/listings', `${listing.id}-${listing.year}-${listing.make}-${listing.model}`.toLowerCase().replace(/\s+/g, '-'));
        if (!existsSync(workspacePath)) {
          mkdirSync(workspacePath, { recursive: true });
        }
        const exportPath = path.join(workspacePath, 'cost.json');
        writeFileSync(exportPath, JSON.stringify(cost, null, 2));
      }
    }

    // Print summary table
    console.log('─'.repeat(70));
    console.log(`${'ID'.padEnd(4)} ${'Vehicle'.padEnd(30)} ${'Asking'.padEnd(12)} ${'Total'.padEnd(12)} Budget`);
    console.log('─'.repeat(70));

    // Sort by total cost
    results.sort((a, b) => a.total - b.total);

    for (const r of results) {
      const asking = `$${r.asking.toLocaleString()}`;
      const total = `$${r.total.toLocaleString()}`;
      const budgetIcon = r.fits ? '✅' : '❌';
      console.log(`${String(r.id).padEnd(4)} ${r.vehicle.slice(0, 29).padEnd(30)} ${asking.padEnd(12)} ${total.padEnd(12)} ${budgetIcon}`);
    }

    console.log('─'.repeat(70));
    console.log(`\nSummary: ${withinBudget} within budget, ${overBudget} over budget`);
    console.log(`Budget: $${budget.toLocaleString()}\n`);

    if (options.export) {
      console.log(`📁 Exported cost.json files to workspace/listings/*/\n`);
    }
  });
