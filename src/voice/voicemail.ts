import * as fs from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import OpenAI from 'openai';
import { getEnv } from '../config.js';
import { runClaudeTask } from '../claude/task-runner.js';
import { writeSearchContext } from '../workspace/index.js';

const CLAUDE_SENTINEL = 'task complete';

export interface TwilioRecording {
  sid: string;
  callSid: string;
  dateCreated: Date;
  duration: number; // seconds
  url: string;
  from: string;
  to: string;
}

export interface Voicemail {
  recording: TwilioRecording;
  audioPath: string | null;
  transcript: string | null;
  parsed: ParsedVoicemail | null;
}

export interface ParsedVoicemail {
  callerName: string | null;
  dealership: string | null;
  vehicleMentioned: string | null;
  callbackNumber: string | null;
  purpose: 'inquiry_response' | 'price_update' | 'availability' | 'schedule' | 'other';
  summary: string;
  actionRequired: boolean;
  suggestedAction: string | null;
}

/**
 * Fetch recent recordings from Twilio
 */
export async function fetchRecordings(since?: Date, limit = 20): Promise<TwilioRecording[]> {
  const accountSid = getEnv('TWILIO_ACCOUNT_SID');
  const authToken = getEnv('TWILIO_AUTH_TOKEN');
  const phoneNumber = getEnv('TWILIO_PHONE_NUMBER');

  const params = new URLSearchParams({
    PageSize: limit.toString(),
  });

  if (since) {
    params.set('DateCreated>', since.toISOString().split('T')[0]);
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Recordings.json?${params.toString()}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
    },
  });

  if (!response.ok) {
    const error = await response.json() as { message?: string };
    throw new Error(`Failed to fetch recordings: ${error.message || response.statusText}`);
  }

  const result = await response.json() as { recordings?: any[] };

  // Also fetch call details to get the caller info
  const recordings: TwilioRecording[] = [];

  for (const rec of result.recordings || []) {
    // Get call details
    const callUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls/${rec.call_sid}.json`;
    const callResponse = await fetch(callUrl, {
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
      },
    });

    let from = 'Unknown';
    let to = phoneNumber;

    if (callResponse.ok) {
      const callData = await callResponse.json() as { from?: string; to?: string };
      from = callData.from || 'Unknown';
      to = callData.to || phoneNumber;
    }

    recordings.push({
      sid: rec.sid,
      callSid: rec.call_sid,
      dateCreated: new Date(rec.date_created),
      duration: parseInt(rec.duration, 10),
      url: `https://api.twilio.com${rec.uri.replace('.json', '.mp3')}`,
      from,
      to,
    });
  }

  return recordings;
}

/**
 * Download a recording to a local file
 */
export async function downloadRecording(recording: TwilioRecording): Promise<string> {
  const accountSid = getEnv('TWILIO_ACCOUNT_SID');
  const authToken = getEnv('TWILIO_AUTH_TOKEN');

  const outputPath = path.join(tmpdir(), `voicemail-${recording.sid}.mp3`);

  const response = await fetch(recording.url, {
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to download recording: ${response.statusText}`);
  }

  const fileStream = fs.createWriteStream(outputPath);
  await pipeline(Readable.fromWeb(response.body as any), fileStream);

  return outputPath;
}

/**
 * Transcribe audio using OpenAI
 */
export async function transcribeAudio(
  audioPath: string,
  model = 'gpt-4o-mini-transcribe'
): Promise<string> {
  const openai = new OpenAI({
    apiKey: getEnv('OPENAI_API_KEY'),
  });

  const { createReadStream } = await import('fs');
  const audioFile = createReadStream(audioPath);

  const result = await openai.audio.transcriptions.create({
    model,
    file: audioFile,
  });

  return result.text;
}

/**
 * Parse voicemail content using Claude
 */
export async function parseVoicemail(
  transcript: string,
  callerNumber: string
): Promise<ParsedVoicemail> {
  const prompt = `You are parsing a voicemail left by a car dealer or seller. Extract key information.

VOICEMAIL TRANSCRIPT:
"${transcript}"

CALLER NUMBER: ${callerNumber}

Respond with a JSON object:
{
  "callerName": "name if mentioned, or null",
  "dealership": "dealership name if mentioned, or null",
  "vehicleMentioned": "vehicle details if mentioned (e.g., '2018 Dodge Grand Caravan'), or null",
  "callbackNumber": "callback number if different from caller, or null",
  "purpose": "inquiry_response|price_update|availability|schedule|other",
  "summary": "1-2 sentence summary of the message",
  "actionRequired": true/false,
  "suggestedAction": "what the buyer should do next, or null if no action needed"
}

Respond ONLY with the JSON object.`;

  try {
    writeSearchContext();
    const workspaceDir = path.resolve('workspace');
    const taskDir = path.join(workspaceDir, 'claude', `voicemail-parse-${Date.now()}`);
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
      model: process.env.CLAUDE_MODEL_VOICEMAIL || process.env.CLAUDE_MODEL || undefined,
      dangerous: process.env.CLAUDE_DANGEROUS !== 'false',
      timeoutMs: 60000,
      sentinel: CLAUDE_SENTINEL,
    });

    if (!fs.existsSync(resultFile)) {
      throw new Error('Claude did not write a result file');
    }

    const raw = fs.readFileSync(resultFile, 'utf-8');
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON in response');
    }

    return JSON.parse(jsonMatch[0]);
  } catch (error) {
    // Fallback parsing
    return {
      callerName: null,
      dealership: null,
      vehicleMentioned: null,
      callbackNumber: null,
      purpose: 'other',
      summary: transcript.slice(0, 200),
      actionRequired: true,
      suggestedAction: 'Listen to voicemail and respond',
    };
  }
}

/**
 * Process a recording: download, transcribe, and parse
 */
export async function processRecording(recording: TwilioRecording): Promise<Voicemail> {
  let audioPath: string | null = null;
  let transcript: string | null = null;
  let parsed: ParsedVoicemail | null = null;

  try {
    // Download the audio
    audioPath = await downloadRecording(recording);

    // Transcribe
    transcript = await transcribeAudio(audioPath);

    // Parse with AI
    parsed = await parseVoicemail(transcript, recording.from);
  } catch (error) {
    console.error(`Failed to process recording ${recording.sid}:`, error);
  }

  return {
    recording,
    audioPath,
    transcript,
    parsed,
  };
}

/**
 * Generate TwiML for voicemail greeting
 */
export function generateVoicemailTwiml(greeting?: string): string {
  const defaultGreeting = "Hi, you've reached the car buyer. I'm currently unavailable. Please leave a message with your name, the vehicle you're calling about, and a callback number. I'll get back to you soon.";

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">${greeting || defaultGreeting}</Say>
  <Record
    maxLength="120"
    playBeep="true"
    transcribe="false"
    action="/recording-complete"
  />
  <Say voice="alice">I didn't receive a message. Goodbye.</Say>
</Response>`;
}
