import { readFileSync } from 'fs';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { runClaudeTask } from '../claude/task-runner.js';
import { writeSearchContext } from '../workspace/index.js';

const CLAUDE_SENTINEL = 'task complete';

// pdf-parse doesn't have proper ESM support, use require
const require = createRequire(import.meta.url);

async function getPdfParser(): Promise<(buffer: Buffer) => Promise<{ text: string }>> {
  return require('pdf-parse');
}

export interface CarfaxData {
  vin: string | null;
  ownerCount: number | null;
  accidentCount: number;
  serviceRecordCount: number;
  titleIssues: string[];
  damageReports: string[];
  odometerReadings: Array<{
    date: string;
    mileage: number;
    source: string;
  }>;
  recalls: string[];
  structuralDamage: boolean;
  airbagDeployed: boolean;
  floodDamage: boolean;
  frameDamage: boolean;
  totalLoss: boolean;
  commercialUse: boolean;
  rentalHistory: boolean;
  lemonHistory: boolean;
  rawText: string;
}

export interface CarfaxAnalysis {
  data: CarfaxData;
  riskLevel: 'low' | 'medium' | 'high' | 'severe';
  riskFactors: string[];
  recommendations: string[];
  summary: string;
}

/**
 * Extract text content from a PDF buffer
 */
export async function extractPdfText(pdfBuffer: Buffer): Promise<string> {
  const parser = await getPdfParser();
  const data = await parser(pdfBuffer);
  return data.text;
}

/**
 * Parse CARFAX text for key data points
 */
export function parseCarfaxText(text: string): CarfaxData {
  const data: CarfaxData = {
    vin: null,
    ownerCount: null,
    accidentCount: 0,
    serviceRecordCount: 0,
    titleIssues: [],
    damageReports: [],
    odometerReadings: [],
    recalls: [],
    structuralDamage: false,
    airbagDeployed: false,
    floodDamage: false,
    frameDamage: false,
    totalLoss: false,
    commercialUse: false,
    rentalHistory: false,
    lemonHistory: false,
    rawText: text,
  };

  const normalizedText = text.toLowerCase();

  // Extract VIN
  const vinMatch = text.match(/VIN[:\s]*([A-HJ-NPR-Z0-9]{17})/i);
  if (vinMatch) {
    data.vin = vinMatch[1].toUpperCase();
  }

  // Extract owner count
  const ownerMatch = text.match(/(\d+)\s*(?:owner|Owner)/);
  if (ownerMatch) {
    data.ownerCount = parseInt(ownerMatch[1], 10);
  }

  // Count accidents
  const accidentMatches = normalizedText.match(/accident|collision|crash|damage report/g);
  if (accidentMatches) {
    data.accidentCount = Math.max(1, Math.floor(accidentMatches.length / 3));
  }

  // Check for specific damage types
  if (/structural\s*damage/i.test(normalizedText)) {
    data.structuralDamage = true;
  }
  if (/airbag\s*deploy/i.test(normalizedText)) {
    data.airbagDeployed = true;
  }
  if (/flood\s*damage|water\s*damage/i.test(normalizedText)) {
    data.floodDamage = true;
  }
  if (/frame\s*damage/i.test(normalizedText)) {
    data.frameDamage = true;
  }
  if (/total\s*loss|salvage/i.test(normalizedText)) {
    data.totalLoss = true;
  }
  if (/commercial|fleet|taxi|rideshare|uber|lyft/i.test(normalizedText)) {
    data.commercialUse = true;
  }
  if (/rental|rent-a-car|enterprise|hertz|avis|budget/i.test(normalizedText)) {
    data.rentalHistory = true;
  }
  if (/lemon|buyback/i.test(normalizedText)) {
    data.lemonHistory = true;
  }

  // Extract odometer readings (simplified pattern)
  const odometerPattern = /(\d{1,2}\/\d{1,2}\/\d{2,4})[^\d]*(\d{1,3},?\d{0,3})\s*(?:km|mi)/gi;
  let odometerMatch;
  while ((odometerMatch = odometerPattern.exec(text)) !== null) {
    const mileage = parseInt(odometerMatch[2].replace(',', ''), 10);
    if (mileage > 0 && mileage < 500000) {
      data.odometerReadings.push({
        date: odometerMatch[1],
        mileage,
        source: 'service record',
      });
    }
  }

  // Count service records
  const serviceMatches = normalizedText.match(/service|maintenance|oil change|inspection/g);
  if (serviceMatches) {
    data.serviceRecordCount = Math.max(1, Math.floor(serviceMatches.length / 2));
  }

  // Extract title issues
  if (/salvage title/i.test(normalizedText)) {
    data.titleIssues.push('Salvage title');
  }
  if (/rebuilt title/i.test(normalizedText)) {
    data.titleIssues.push('Rebuilt title');
  }
  if (/title brand/i.test(normalizedText)) {
    data.titleIssues.push('Title brand reported');
  }

  return data;
}

/**
 * Analyze CARFAX data using Claude AI
 */
export async function analyzeCarfaxWithAI(data: CarfaxData): Promise<CarfaxAnalysis> {
  const prompt = `You are analyzing a CARFAX vehicle history report. Based on the extracted data below, provide a risk assessment.

EXTRACTED DATA:
- VIN: ${data.vin || 'Not found'}
- Owner Count: ${data.ownerCount || 'Unknown'}
- Accident Count: ${data.accidentCount}
- Service Record Count: ${data.serviceRecordCount}
- Title Issues: ${data.titleIssues.length > 0 ? data.titleIssues.join(', ') : 'None'}
- Structural Damage: ${data.structuralDamage ? 'YES - REPORTED' : 'No'}
- Airbag Deployed: ${data.airbagDeployed ? 'YES - REPORTED' : 'No'}
- Flood Damage: ${data.floodDamage ? 'YES - REPORTED' : 'No'}
- Frame Damage: ${data.frameDamage ? 'YES - REPORTED' : 'No'}
- Total Loss/Salvage: ${data.totalLoss ? 'YES - REPORTED' : 'No'}
- Commercial/Fleet Use: ${data.commercialUse ? 'YES' : 'No'}
- Rental History: ${data.rentalHistory ? 'YES' : 'No'}
- Lemon/Buyback: ${data.lemonHistory ? 'YES - REPORTED' : 'No'}
- Odometer Readings: ${data.odometerReadings.length} recorded

RAW TEXT EXCERPT (first 3000 chars):
${data.rawText.slice(0, 3000)}

Respond with a JSON object containing:
{
  "riskLevel": "low" | "medium" | "high" | "severe",
  "riskFactors": ["list of specific concerns"],
  "recommendations": ["list of what buyer should do/ask"],
  "summary": "2-3 sentence summary of the vehicle's history"
}

Risk level guidelines:
- severe: Total loss, salvage title, flood damage, structural damage, or airbag deployment
- high: Multiple accidents, frame damage, lemon history, or major title issues
- medium: Single accident, commercial/rental history, or 3+ owners
- low: Clean history with regular service

Respond ONLY with the JSON object, no other text.`;

  try {
    writeSearchContext();
    const workspaceDir = path.resolve('workspace');
    const taskDir = path.join(workspaceDir, 'claude', `carfax-analysis-${Date.now()}`);
    fs.mkdirSync(taskDir, { recursive: true });
    const taskFile = path.join(taskDir, 'task.md');
    const resultFile = path.join(taskDir, 'result.json');
    const resultRel = path.relative(workspaceDir, resultFile);

    const taskBody = `${prompt}

---

Write ONLY the JSON to: ${resultRel}

After writing the file, output this line exactly:
${CLAUDE_SENTINEL}
`;
    fs.writeFileSync(taskFile, taskBody);

    await runClaudeTask({
      workspaceDir,
      taskFile: path.relative(workspaceDir, taskFile),
      resultFile: resultRel,
      model: process.env.CLAUDE_MODEL_CARFAX || process.env.CLAUDE_MODEL || undefined,
      dangerous: process.env.CLAUDE_DANGEROUS !== 'false',
      timeoutMs: 120000,
      sentinel: CLAUDE_SENTINEL,
    });

    if (!fs.existsSync(resultFile)) {
      throw new Error('Claude did not write a result file');
    }

    const raw = fs.readFileSync(resultFile, 'utf-8');
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found in AI response');
    }

    const analysis = JSON.parse(jsonMatch[0]);

    return {
      data,
      riskLevel: analysis.riskLevel || 'medium',
      riskFactors: analysis.riskFactors || [],
      recommendations: analysis.recommendations || [],
      summary: analysis.summary || 'Unable to generate summary',
    };
  } catch (error) {
    // Fallback to rule-based analysis if AI fails
    return generateFallbackAnalysis(data);
  }
}

/**
 * Generate fallback analysis without AI
 */
function generateFallbackAnalysis(data: CarfaxData): CarfaxAnalysis {
  const riskFactors: string[] = [];
  let riskLevel: 'low' | 'medium' | 'high' | 'severe' = 'low';

  // Severe risks
  if (data.totalLoss || data.structuralDamage || data.floodDamage || data.airbagDeployed) {
    riskLevel = 'severe';
    if (data.totalLoss) riskFactors.push('Vehicle was declared total loss or has salvage history');
    if (data.structuralDamage) riskFactors.push('Structural damage reported');
    if (data.floodDamage) riskFactors.push('Flood/water damage reported');
    if (data.airbagDeployed) riskFactors.push('Airbag deployment reported');
  }
  // High risks
  else if (data.frameDamage || data.lemonHistory || data.accidentCount >= 2 || data.titleIssues.length > 0) {
    riskLevel = 'high';
    if (data.frameDamage) riskFactors.push('Frame damage reported');
    if (data.lemonHistory) riskFactors.push('Lemon law buyback history');
    if (data.accidentCount >= 2) riskFactors.push(`${data.accidentCount} accidents reported`);
    data.titleIssues.forEach(issue => riskFactors.push(issue));
  }
  // Medium risks
  else if (data.accidentCount === 1 || data.commercialUse || data.rentalHistory || (data.ownerCount && data.ownerCount >= 3)) {
    riskLevel = 'medium';
    if (data.accidentCount === 1) riskFactors.push('1 accident reported');
    if (data.commercialUse) riskFactors.push('Commercial/fleet use history');
    if (data.rentalHistory) riskFactors.push('Rental vehicle history');
    if (data.ownerCount && data.ownerCount >= 3) riskFactors.push(`${data.ownerCount} previous owners`);
  }

  const recommendations: string[] = [];
  if (riskLevel === 'severe') {
    recommendations.push('AVOID this vehicle - serious history issues detected');
    recommendations.push('If still considering, require independent pre-purchase inspection');
  } else if (riskLevel === 'high') {
    recommendations.push('Proceed with caution - significant concerns detected');
    recommendations.push('Get professional pre-purchase inspection before considering');
    recommendations.push('Request all repair documentation from seller');
  } else if (riskLevel === 'medium') {
    recommendations.push('Get pre-purchase inspection by independent mechanic');
    recommendations.push('Verify all reported issues have been properly repaired');
  } else {
    recommendations.push('Standard pre-purchase inspection recommended');
  }

  let summary = '';
  if (riskLevel === 'severe') {
    summary = `This vehicle has severe history issues including ${riskFactors.slice(0, 2).join(' and ')}. Not recommended for purchase.`;
  } else if (riskLevel === 'high') {
    summary = `This vehicle has significant concerns: ${riskFactors.slice(0, 2).join(', ')}. Requires thorough inspection if considering.`;
  } else if (riskLevel === 'medium') {
    summary = `This vehicle has some concerns (${riskFactors.slice(0, 2).join(', ')}) but may be acceptable with proper inspection.`;
  } else {
    summary = `This vehicle appears to have a clean history with ${data.serviceRecordCount} service records. Standard inspection recommended.`;
  }

  return {
    data,
    riskLevel,
    riskFactors,
    recommendations,
    summary,
  };
}

/**
 * Analyze a CARFAX PDF file
 */
export async function analyzeCarfaxPdf(pdfPath: string): Promise<CarfaxAnalysis> {
  const pdfBuffer = readFileSync(pdfPath);
  const text = await extractPdfText(pdfBuffer);
  const data = parseCarfaxText(text);
  return analyzeCarfaxWithAI(data);
}

/**
 * Analyze a CARFAX PDF from a buffer (e.g., email attachment)
 */
export async function analyzeCarfaxBuffer(pdfBuffer: Buffer): Promise<CarfaxAnalysis> {
  const text = await extractPdfText(pdfBuffer);
  const data = parseCarfaxText(text);
  return analyzeCarfaxWithAI(data);
}
