import { Command } from 'commander';
import { getDatabase } from '../../database/index.js';
import { loadConfig } from '../../config.js';
import { calculateTotalCost, formatCostBreakdown, parseTrimLevel } from '../../pricing/calculator.js';
import type { ListingAnalysis } from '../../analyzers/listing-analyzer.js';

export const showCommand = new Command('show')
  .description('Show details for a specific listing')
  .argument('<id>', 'Listing ID')
  .action(async (id) => {
    try {
      const db = getDatabase();
      const config = loadConfig();
      const listing = db.getListing(parseInt(id, 10));

      if (!listing) {
        console.error(`Listing #${id} not found.`);
        process.exit(1);
      }

      console.log('\n' + '='.repeat(60));
      console.log(`${listing.year} ${listing.make} ${listing.model}${listing.trim ? ` ${listing.trim}` : ''}`);
      console.log('='.repeat(60));

      console.log('\n📋 Basic Info:');
      console.log(`  ID:       #${listing.id}`);
      console.log(`  Status:   ${listing.status}`);
      console.log(`  Source:   ${listing.source}`);
      console.log(`  URL:      ${listing.sourceUrl}`);
      if (listing.vin) {
        console.log(`  VIN:      ${listing.vin}`);
      }

      console.log('\n💰 Pricing & Mileage:');
      console.log(`  Listed:   ${listing.price ? `$${listing.price.toLocaleString()}` : 'N/A'}`);
      console.log(`  Mileage:  ${listing.mileageKm ? `${listing.mileageKm.toLocaleString()} km` : 'N/A'}`);

      // Parse AI analysis for pricing info
      let analysis: ListingAnalysis | null = null;
      if (listing.aiAnalysis) {
        try {
          analysis = JSON.parse(listing.aiAnalysis);
        } catch {}
      }

      // Calculate and show total cost breakdown
      if (listing.price) {
        const isDealer = listing.sellerType === 'dealer';
        const budget = config.search.priceMax || 18000;
        const costBreakdown = calculateTotalCost(
          listing.price,
          analysis?.pricing || null,
          budget,
          isDealer
        );

        console.log('\n💵 Estimated Total Cost (Ontario):');
        const breakdownLines = formatCostBreakdown(costBreakdown, budget).split('\n');
        for (const line of breakdownLines) {
          console.log(`  ${line}`);
        }
      }

      // Price history
      const priceHistory = db.getPriceHistory(listing.id);
      if (priceHistory.length > 1) {
        console.log('\n  Price History:');
        for (const record of priceHistory.slice(0, 5)) {
          console.log(`    $${record.price.toLocaleString()} on ${record.recordedAt}`);
        }
      }

      // Show detected trim level
      const titleText = `${listing.year} ${listing.make} ${listing.model} ${listing.trim || ''}`;
      const trimInfo = parseTrimLevel(titleText, listing.description || '');
      if (trimInfo || analysis?.detectedTrim) {
        const trim = analysis?.detectedTrim || trimInfo?.trim;
        console.log(`\n🚗 Trim Level: ${trim}`);
        if (trimInfo && trimInfo.rank >= 4) {
          console.log(`   ⬆️ Higher than base model - good value if priced similarly!`);
        }
      }

      console.log('\n📍 Location:');
      const location = [listing.city, listing.province].filter(Boolean).join(', ');
      console.log(`  Location: ${location || 'N/A'}`);
      if (listing.distanceKm) {
        console.log(`  Distance: ${listing.distanceKm} km`);
      }

      console.log('\n🏪 Seller:');
      console.log(`  Type:     ${listing.sellerType || 'N/A'}`);
      console.log(`  Name:     ${listing.sellerName || 'N/A'}`);
      if (listing.sellerPhone) {
        console.log(`  Phone:    ${listing.sellerPhone}`);
      }
      if (listing.sellerEmail) {
        console.log(`  Email:    ${listing.sellerEmail}`);
      }
      if (listing.dealerRating) {
        console.log(`  Rating:   ${'⭐'.repeat(Math.round(listing.dealerRating))} (${listing.dealerRating}/5)`);
      }

      if (listing.carfaxReceived) {
        console.log('\n📄 CARFAX:');
        console.log(`  Received: ✅`);
        if (listing.carfaxPath) {
          console.log(`  File:     ${listing.carfaxPath}`);
        }
        console.log(`  Accidents: ${listing.accidentCount ?? 'N/A'}`);
        console.log(`  Owners:    ${listing.ownerCount ?? 'N/A'}`);
        console.log(`  Service Records: ${listing.serviceRecordCount ?? 'N/A'}`);
        if (listing.carfaxSummary) {
          console.log(`\n  Summary:\n  ${listing.carfaxSummary.split('\n').join('\n  ')}`);
        }
      }

      if (listing.score !== null) {
        console.log('\n📊 Score:');
        console.log(`  Score:    ${listing.score}/100`);
      }

      if (listing.redFlags && listing.redFlags.length > 0) {
        console.log('\n⚠️  Red Flags:');
        for (const flag of listing.redFlags) {
          console.log(`  - ${flag}`);
        }
      }

      if (listing.aiAnalysis && analysis) {
        console.log('\n🤖 AI Analysis:');
        console.log(`  Score: ${analysis.recommendationScore}/100 | Condition: ${analysis.estimatedCondition}`);

        if (analysis.positives?.length > 0) {
          console.log('  ✅ Positives:');
          for (const p of analysis.positives) {
            console.log(`     + ${p}`);
          }
        }

        if (analysis.concerns?.length > 0) {
          console.log('  ⚠️  To Verify:');
          for (const c of analysis.concerns) {
            console.log(`     ? ${c}`);
          }
        }

        // Show pricing analysis
        if (analysis.pricing) {
          console.log('\n  💳 Pricing Analysis:');
          console.log(`     Type: ${analysis.pricing.pricingType}`);
          console.log(`     Certification: ${analysis.pricing.certificationStatus}`);
          if (analysis.pricing.mentionedFees?.length > 0) {
            console.log('     Mentioned fees:');
            for (const fee of analysis.pricing.mentionedFees) {
              const amt = fee.amount ? `$${fee.amount}` : 'amount unknown';
              console.log(`       - ${fee.name}: ${amt}`);
            }
          }
        }

        // Show deception flags
        if (analysis.deception) {
          const hasDeception =
            (analysis.deception.deceptiveLanguage?.length || 0) > 0 ||
            (analysis.deception.hiddenCosts?.length || 0) > 0 ||
            (analysis.deception.missingInfo?.length || 0) > 0;

          if (hasDeception) {
            console.log('\n  🚨 Deception Detection:');
            if (analysis.deception.deceptiveLanguage?.length > 0) {
              console.log('     Suspicious language:');
              for (const d of analysis.deception.deceptiveLanguage) {
                console.log(`       ⚠️  ${d}`);
              }
            }
            if (analysis.deception.hiddenCosts?.length > 0) {
              console.log('     Potential hidden costs:');
              for (const h of analysis.deception.hiddenCosts) {
                console.log(`       💸 ${h}`);
              }
            }
            if (analysis.deception.missingInfo?.length > 0) {
              console.log('     Missing information:');
              for (const m of analysis.deception.missingInfo) {
                console.log(`       ❓ ${m}`);
              }
            }
          }
        }

        if (analysis.summary) {
          console.log(`\n  💬 ${analysis.summary}`);
        }
      }

      if (listing.description) {
        console.log('\n📝 Description:');
        console.log(`  ${listing.description.slice(0, 500)}${listing.description.length > 500 ? '...' : ''}`);
      }

      if (listing.specs) {
        console.log('\n🔧 Vehicle Specifications:');
        const s = listing.specs;
        if (s.bodyType) console.log(`  Body Type:    ${s.bodyType}`);
        if (s.engine) console.log(`  Engine:       ${s.engine}`);
        if (s.cylinders) console.log(`  Cylinders:    ${s.cylinders}`);
        if (s.transmission) console.log(`  Transmission: ${s.transmission}`);
        if (s.drivetrain) console.log(`  Drivetrain:   ${s.drivetrain}`);
        if (s.fuelType) console.log(`  Fuel Type:    ${s.fuelType}`);
        if (s.exteriorColor) console.log(`  Exterior:     ${s.exteriorColor}`);
        if (s.interiorColor) console.log(`  Interior:     ${s.interiorColor}`);
        if (s.doors) console.log(`  Doors:        ${s.doors}`);
        if (s.passengers) console.log(`  Passengers:   ${s.passengers}`);
        if (s.fuelCityL100km || s.fuelHighwayL100km) {
          const city = s.fuelCityL100km ? `${s.fuelCityL100km} L/100km city` : '';
          const hwy = s.fuelHighwayL100km ? `${s.fuelHighwayL100km} L/100km hwy` : '';
          const combined = s.fuelCombinedL100km ? `${s.fuelCombinedL100km} L/100km combined` : '';
          console.log(`  Fuel Economy: ${[city, hwy, combined].filter(Boolean).join(' / ')}`);
        }
      }

      if (listing.notes) {
        console.log('\n📌 Notes:');
        console.log(`  ${listing.notes}`);
      }

      if (listing.photoUrls && listing.photoUrls.length > 0) {
        console.log(`\n📷 Photos: ${listing.photoUrls.length} available`);
      }

      console.log('\n🕐 Timestamps:');
      console.log(`  Discovered: ${listing.discoveredAt}`);
      console.log(`  Updated:    ${listing.updatedAt}`);
      if (listing.lastContactedAt) {
        console.log(`  Contacted:  ${listing.lastContactedAt}`);
      }

      console.log('');
    } catch (error) {
      console.error('Error showing listing:', error);
      process.exit(1);
    }
  });
