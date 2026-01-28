import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

export interface Job {
  id: string;
  command: string;
  args: string[];
  status: 'running' | 'completed' | 'failed';
  output: string[];
  startedAt: Date;
  completedAt?: Date;
  exitCode?: number;
}

// In-memory job store (resets on server restart)
const jobs = new Map<string, Job>();
const processes = new Map<string, ChildProcess>();

/**
 * Find the project root directory
 * This file is at: web/src/lib/jobs.ts
 * Project root is 3 levels up: web/ -> project root
 */
function findProjectRoot(): string {
  // Try multiple strategies to find the project root
  const candidates: string[] = [];

  // Strategy 1: Navigate up from this file's location
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    // From web/src/lib/ go up 3 levels to project root
    candidates.push(path.resolve(__dirname, '..', '..', '..'));
  } catch {
    // import.meta.url might not work in all environments
  }

  // Strategy 2: Navigate up from cwd (assuming started from web/)
  candidates.push(path.resolve(process.cwd(), '..'));

  // Strategy 3: Use cwd directly (if started from project root)
  candidates.push(process.cwd());

  // Find the first candidate that has package.json with the right name
  for (const candidate of candidates) {
    const pkgPath = path.join(candidate, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg.name === 'carguru-search') {
          console.log(`[Jobs] Using project root: ${candidate}`);
          return candidate;
        }
      } catch {
        // Continue to next candidate
      }
    }
  }

  // Fallback to first candidate
  console.warn(`[Jobs] Could not find project root, using: ${candidates[0]}`);
  return candidates[0];
}

const PROJECT_ROOT = findProjectRoot();

export function createJob(command: string, args: string[]): Job {
  const id = `job-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  const job: Job = {
    id,
    command,
    args,
    status: 'running',
    output: [],
    startedAt: new Date(),
  };
  jobs.set(id, job);
  return job;
}

export function runJob(job: Job): void {
  const fullCommand = 'npm';
  const fullArgs = ['run', 'dev', '--', job.command, ...job.args];

  console.log(`[Job ${job.id}] Running: ${fullCommand} ${fullArgs.join(' ')}`);
  console.log(`[Job ${job.id}] CWD: ${PROJECT_ROOT}`);

  const proc = spawn(fullCommand, fullArgs, {
    cwd: PROJECT_ROOT,
    env: { ...process.env, FORCE_COLOR: '0' },
    shell: true,
  });

  processes.set(job.id, proc);

  proc.stdout?.on('data', (data: Buffer) => {
    const lines = data.toString().split('\n').filter(Boolean);
    job.output.push(...lines);
    // Keep only last 500 lines
    if (job.output.length > 500) {
      job.output = job.output.slice(-500);
    }
  });

  proc.stderr?.on('data', (data: Buffer) => {
    const lines = data.toString().split('\n').filter(Boolean);
    job.output.push(...lines.map(l => `[stderr] ${l}`));
    if (job.output.length > 500) {
      job.output = job.output.slice(-500);
    }
  });

  proc.on('close', (code: number | null) => {
    job.status = code === 0 ? 'completed' : 'failed';
    job.completedAt = new Date();
    job.exitCode = code ?? undefined;
    processes.delete(job.id);
    console.log(`[Job ${job.id}] Completed with code ${code}`);
  });

  proc.on('error', (err: Error) => {
    job.status = 'failed';
    job.completedAt = new Date();
    job.output.push(`[error] ${err.message}`);
    processes.delete(job.id);
    console.log(`[Job ${job.id}] Error: ${err.message}`);
  });
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function getAllJobs(): Job[] {
  return Array.from(jobs.values()).sort(
    (a, b) => b.startedAt.getTime() - a.startedAt.getTime()
  );
}

export function stopJob(id: string): boolean {
  const proc = processes.get(id);
  if (proc) {
    proc.kill('SIGTERM');
    const job = jobs.get(id);
    if (job) {
      job.status = 'failed';
      job.completedAt = new Date();
      job.output.push('[stopped] Job was manually stopped');
    }
    processes.delete(id);
    return true;
  }
  return false;
}

export function clearOldJobs(): void {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  for (const [id, job] of jobs.entries()) {
    if (job.completedAt && job.completedAt.getTime() < oneHourAgo) {
      jobs.delete(id);
    }
  }
}

// Clean up old jobs every 10 minutes
setInterval(clearOldJobs, 10 * 60 * 1000);
