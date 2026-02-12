import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import stripAnsi from 'strip-ansi';
import { computeAmpCost, parseAmpUsage } from '../adapters/amp.js';
import { KILL_GRACE_PERIOD, TEST_TIMEOUT } from '../constants.js';
import type {
  CostInfo,
  ExecResult,
  Invocation,
  TestResult,
  ToolAdapter,
  ToolConfig,
} from '../types.js';
import { debug } from '../ui/logger.js';

const execFileAsync = promisify(execFile);

const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10MB

const activeChildren = new Set<ChildProcess>();

process.on('SIGINT', () => {
  for (const child of activeChildren) {
    child.kill('SIGTERM');
  }
  // Give children a moment to exit, then force-exit
  setTimeout(() => process.exit(1), 2000);
});

const ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'TERM',
  'LANG',
  'SHELL',
  'TMPDIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  // Node version managers
  'NVM_BIN',
  'NVM_DIR',
  'FNM_MULTISHELL_PATH',
  // API keys for adapters
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENAI_ORG_ID',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'AMP_API_KEY',
  // Proxy
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  // Node runtime
  'NODE_OPTIONS',
] as const;

function buildSafeEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  if (extra) Object.assign(env, extra);
  env.CI = 'true';
  env.NO_COLOR = '1';
  return env;
}

/**
 * Execute a tool invocation with timeout and output capture.
 * Uses child_process.spawn — no shell: true (security).
 */
export function execute(
  invocation: Invocation,
  timeoutMs: number,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killed = false;
    let killTimer: NodeJS.Timeout | undefined;
    let truncated = false;

    debug(`Executing: ${invocation.cmd} ${invocation.args.join(' ')}`);

    const child = spawn(invocation.cmd, invocation.args, {
      cwd: invocation.cwd,
      env: buildSafeEnv(invocation.env),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const isWin = process.platform === "win32";
    const child = isWin
      ? spawn(
          [invocation.cmd, ...invocation.args.map((a) => (a.includes(" ") ? `"${a}"` : a))].join(" "),
          {
            cwd: invocation.cwd,
            env: buildSafeEnv(invocation.env),
            stdio: ["pipe", "pipe", "pipe"],
            shell: true,
          },
        )
      : spawn(invocation.cmd, invocation.args, {
          cwd: invocation.cwd,
          env: buildSafeEnv(invocation.env),
          stdio: ["pipe", "pipe", "pipe"],
        });

    // Track active children for SIGINT cleanup
    activeChildren.add(child);

    child.stdout.on('data', (data: Buffer) => {
      if (!truncated && stdout.length < MAX_OUTPUT_BYTES) {
        stdout += data.toString();
        if (stdout.length >= MAX_OUTPUT_BYTES) {
          truncated = true;
          stdout = `${stdout.slice(0, MAX_OUTPUT_BYTES)}\n[output truncated at 10MB]`;
        }
      }
    });

    child.stderr.on('data', (data: Buffer) => {
      if (stderr.length < MAX_OUTPUT_BYTES) {
        stderr += data.toString();
      }
    });

    // Write stdin if provided
    if (invocation.stdin) {
      child.stdin.write(invocation.stdin);
      child.stdin.end();
    } else {
      child.stdin.end();
    }

    // Timeout: SIGTERM first, SIGKILL after grace period
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        if (!killed) {
          child.kill('SIGKILL');
        }
      }, KILL_GRACE_PERIOD);
    }, timeoutMs);

    child.on('close', (code) => {
      killed = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      activeChildren.delete(child);
      resolve({
        exitCode: code ?? 1,
        stdout: stripAnsi(stdout),
        stderr: stripAnsi(stderr),
        timedOut,
        durationMs: Date.now() - start,
      });
    });

    child.on('error', (err) => {
      killed = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      activeChildren.delete(child);
      resolve({
        exitCode: 1,
        stdout: '',
        stderr: err.message,
        timedOut: false,
        durationMs: Date.now() - start,
      });
    });
  });
}

/**
 * Capture amp usage before/after a run to compute cost.
 */
export async function captureAmpUsage(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('amp', ['usage'], {
      timeout: 10_000,
      encoding: 'utf-8',
      shell: process.platform === "win32",
    });
    return stdout;
  } catch {
    return null;
  }
}

/**
 * Compute amp cost from before/after usage snapshots.
 */
export function computeAmpCostFromSnapshots(
  before: string,
  after: string,
): CostInfo | null {
  try {
    const beforeParsed = parseAmpUsage(before);
    const afterParsed = parseAmpUsage(after);
    return computeAmpCost(beforeParsed, afterParsed);
  } catch {
    return null;
  }
}

/**
 * Test a tool using the "reply OK" protocol.
 */
export async function executeTest(
  adapter: ToolAdapter,
  toolConfig: ToolConfig,
  toolName?: string,
): Promise<TestResult> {
  const prompt = 'Reply with exactly: OK';
  const start = Date.now();

  const invocation = adapter.buildInvocation({
    prompt,
    promptFilePath: '',
    toolId: adapter.id,
    outputDir: '',
    readOnlyPolicy: 'none',
    timeout: TEST_TIMEOUT / 1000,
    cwd: process.cwd(),
    extraFlags: toolConfig.extraFlags,
  });

  // Override: for test, we pass a simple prompt as argument or stdin.
  // Check invocation.stdin (set by the adapter) rather than config.stdin,
  // so built-in stdin adapters (Amp, Gemini) are handled correctly.
  if (invocation.stdin != null) {
    invocation.stdin = prompt;
    // Remove any --settings-file flags for test
    invocation.args = invocation.args.filter((a, i, arr) => {
      if (a === '--settings-file') return false;
      if (i > 0 && arr[i - 1] === '--settings-file') return false;
      return true;
    });
  } else {
    // Replace prompt file instruction with direct prompt
    const lastArgIdx = invocation.args.length - 1;
    invocation.args[lastArgIdx] = prompt;
  }

  const result = await execute(invocation, TEST_TIMEOUT);

  const passed = result.stdout.includes('OK');
  return {
    toolId: toolName ?? adapter.id,
    passed,
    output: result.stdout.slice(0, 500),
    error: !passed
      ? result.stderr.slice(0, 500) || 'Output did not contain "OK"'
      : undefined,
    durationMs: Date.now() - start,
  };
}
