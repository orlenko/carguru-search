import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

export interface ClaudeTaskOptions {
  workspaceDir: string;
  taskFile: string;   // relative to workspaceDir, or absolute within workspaceDir
  resultFile: string; // relative to workspaceDir, or absolute within workspaceDir
  model?: string;
  timeoutMs?: number;
  sentinel?: string;
  dangerous?: boolean;
  debug?: boolean;
}

export interface ClaudeTaskResult {
  stdout: string;
  stderr: string;
  completed: boolean;
  durationMs: number;
}

function resolveWithinWorkspace(workspaceDir: string, filePath: string): string {
  const resolvedWorkspace = path.resolve(workspaceDir);
  const resolvedFile = path.resolve(resolvedWorkspace, filePath);

  if (!resolvedFile.startsWith(resolvedWorkspace + path.sep) && resolvedFile !== resolvedWorkspace) {
    throw new Error(`Path must be within workspace: ${filePath}`);
  }

  return resolvedFile;
}

function toWorkspaceRelative(workspaceDir: string, filePath: string): string {
  const resolvedWorkspace = path.resolve(workspaceDir);
  const resolvedFile = path.resolve(resolvedWorkspace, filePath);
  return path.relative(resolvedWorkspace, resolvedFile);
}

export async function runClaudeTask(options: ClaudeTaskOptions): Promise<ClaudeTaskResult> {
  const start = Date.now();
  const timeoutMs = options.timeoutMs ?? 120000;
  const sentinel = options.sentinel ?? 'task complete';
  const workspaceDir = path.resolve(options.workspaceDir);
  const logPrompt = options.debug || process.env.CLAUDE_LOG_PROMPT === 'true' || process.env.CLAUDE_LOG_PROMPT === '1';
  const logTaskFile = options.debug || process.env.CLAUDE_LOG_TASK === 'true' || process.env.CLAUDE_LOG_TASK === '1';
  const logIo = options.debug || process.env.CLAUDE_LOG_IO === 'true' || process.env.CLAUDE_LOG_IO === '1';

  // Validate paths are inside workspace
  const taskPath = resolveWithinWorkspace(workspaceDir, options.taskFile);
  const resultPath = resolveWithinWorkspace(workspaceDir, options.resultFile);

  if (!fs.existsSync(taskPath)) {
    throw new Error(`Task file not found: ${taskPath}`);
  }

  const taskRel = toWorkspaceRelative(workspaceDir, taskPath);
  const resultRel = toWorkspaceRelative(workspaceDir, resultPath);

  const args = ['--print'];
  if (options.model) {
    args.push('--model', options.model);
  }
  if (options.dangerous) {
    args.push('--dangerously-skip-permissions');
  }
  const promptArg =
    `Read "${taskRel}" and follow its instructions. ` +
    `When finished, output "${sentinel}" on its own line.`;

  if (logPrompt) {
    console.log(`   [CLAUDE] workspace: ${workspaceDir}`);
    console.log(`   [CLAUDE] task file: ${taskPath}`);
    console.log(`   [CLAUDE] result file: ${resultPath}`);
    console.log(`   [CLAUDE] prompt: ${promptArg}`);
    console.log(`   [CLAUDE] args: ${args.join(' ')}`);
  }
  if (logTaskFile) {
    try {
      const taskContent = fs.readFileSync(taskPath, 'utf-8');
      console.log('   [CLAUDE] task file contents start');
      console.log(taskContent);
      console.log('   [CLAUDE] task file contents end');
    } catch (error) {
      console.log(`   [CLAUDE] Failed to read task file for logging: ${error}`);
    }
  }

  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, {
      cwd: workspaceDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
    });

    if (child.stdin) {
      child.stdin.write(promptArg);
      child.stdin.end();
    } else {
      clearTimeout(timeout);
      reject(new Error('Claude stdin unavailable'));
      return;
    }

    let stdout = '';
    let stderr = '';
    let completed = false;
    let lineBuffer = '';
    let killScheduled = false;

    const scheduleKill = () => {
      if (killScheduled) return;
      killScheduled = true;
      setTimeout(() => {
        if (!child.killed) {
          child.kill();
        }
      }, 300);
    };

    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Claude process timed out'));
    }, timeoutMs);

    child.stdout?.on('data', (data) => {
      const chunk = data.toString();
      stdout += chunk;
      lineBuffer += chunk;

      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.trim() === sentinel) {
          completed = true;
          scheduleKill();
        }
      }
    });

    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to invoke Claude: ${err.message}`));
    });

    child.on('exit', (code) => {
      clearTimeout(timeout);

      if (logIo) {
        try {
          const taskDir = path.dirname(taskPath);
          fs.writeFileSync(path.join(taskDir, 'claude-stdout.log'), stdout);
          fs.writeFileSync(path.join(taskDir, 'claude-stderr.log'), stderr);
        } catch (error) {
          // Best-effort logging only
          console.log(`   [CLAUDE] Failed to write IO logs: ${error}`);
        }
      }

      if (!completed && code !== 0) {
        const errDetail = (stderr.trim() || stdout.trim() || '').trim();
        reject(new Error(`Claude exited with code ${code}: ${errDetail}`));
        return;
      }

      resolve({
        stdout,
        stderr,
        completed,
        durationMs: Date.now() - start,
      });
    });
  });
}
