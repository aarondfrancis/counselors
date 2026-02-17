import { type ChildProcess, execFileSync } from 'node:child_process';
import { delimiter, dirname, isAbsolute, normalize, parse } from 'node:path';
import crossSpawn from 'cross-spawn';
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

const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10MB
const WINDOWS_TASKKILL_TIMEOUT_MS = 1500;

const activeChildren = new Set<ChildProcess>();

/** Kill an entire process group, falling back to just the child. */
function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform === 'win32') {
    try {
      if (child.pid) {
        const taskkillArgs = ['/PID', String(child.pid), '/T'];
        if (signal === 'SIGKILL') {
          taskkillArgs.push('/F');
        }

        // Windows has no POSIX process groups; kill the full process tree.
        execFileSync('taskkill', taskkillArgs, {
          stdio: 'ignore',
          windowsHide: true,
          timeout: WINDOWS_TASKKILL_TIMEOUT_MS,
        });
        return;
      }
    } catch {
      // Fall through to direct child kill.
    }
  }

  try {
    if (child.pid) {
      process.kill(-child.pid, signal);
      return;
    }
  } catch {
    // Fall through to direct child kill.
  }

  try {
    child.kill(signal);
  } catch {
    /* already dead */
  }
}

process.on('SIGINT', () => {
  for (const child of activeChildren) {
    killProcessGroup(child, 'SIGTERM');
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
  'TEMP',
  'TMP',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  // Windows system environment (needed for .cmd resolution and child tools)
  'PATHEXT',
  'SystemRoot',
  'WINDIR',
  'ComSpec',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
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
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
  'AMP_API_KEY',
  // GitHub CLI auth
  'GH_TOKEN',
  'GITHUB_TOKEN',
  // Proxy
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  // NOTE: NODE_OPTIONS intentionally excluded — it allows injecting
  // --require flags that execute arbitrary code in child processes.
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

function normalizeWindowsPathForComparison(path: string): string {
  const trimmed = path.trim().replace(/^"(.*)"$/, '$1');
  const normalized = normalize(trimmed);
  const root = parse(normalized).root;
  // Keep trailing separator on roots (e.g. "C:\\" or "\\\\server\\share\\").
  const withoutTrailing =
    normalized === root ? normalized : normalized.replace(/[\\/]+$/, '');
  return withoutTrailing.toLowerCase();
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

    const env = buildSafeEnv(invocation.env);

    // On Windows, ensure the binary's parent directory is in PATH.
    // cross-spawn uses `which` to pre-resolve the command; if `which` fails,
    // `parsed.file` stays null and cross-spawn converts ANY exit-code-1 into a
    // synthetic ENOENT — even when cmd.exe actually found and ran the binary.
    // Adding the directory guarantees `which` resolves .cmd/.bat wrappers so
    // real errors (auth failures, bad args, etc.) are reported correctly.
    if (process.platform === 'win32' && isAbsolute(invocation.cmd)) {
      const binDir = dirname(invocation.cmd);
      const currentPath = env.PATH ?? env.Path ?? '';
      const parts = currentPath
        .split(delimiter)
        .map((p) => p.trim())
        .filter(Boolean);
      const normalizedBinDir = normalizeWindowsPathForComparison(binDir);
      const hasBinDir = parts.some(
        (p) => normalizeWindowsPathForComparison(p) === normalizedBinDir,
      );

      if (!hasBinDir) {
        const nextPath = currentPath
          ? `${binDir}${delimiter}${currentPath}`
          : binDir;
        env.PATH = nextPath;
        if (env.Path != null) env.Path = nextPath;
      }
    }

    const child = crossSpawn(invocation.cmd, invocation.args, {
      cwd: invocation.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // On POSIX, detached creates a new process group so we can kill the
      // entire tree with process.kill(-pid).  On Windows this breaks stdout
      // capture for .cmd/.bat wrappers (cross-spawn routes them through
      // cmd.exe /c and the new console swallows the pipes).  Windows process
      // tree killing is handled via taskkill /T instead.
      detached: process.platform !== 'win32',
      shell: false,
      windowsHide: true,
    });

    const stdoutStream = child.stdout;
    const stderrStream = child.stderr;
    const stdinStream = child.stdin;

    if (!stdoutStream || !stderrStream || !stdinStream) {
      resolve({
        exitCode: 1,
        stdout: '',
        stderr: 'Failed to initialize child process stdio streams.',
        timedOut: false,
        durationMs: Date.now() - start,
      });
      return;
    }

    // Track active children for SIGINT cleanup
    activeChildren.add(child);

    stdoutStream.on('data', (data: Buffer) => {
      if (!truncated && stdout.length < MAX_OUTPUT_BYTES) {
        stdout += data.toString();
        if (stdout.length >= MAX_OUTPUT_BYTES) {
          truncated = true;
          stdout = `${stdout.slice(0, MAX_OUTPUT_BYTES)}\n[output truncated at 10MB]`;
        }
      }
    });

    stderrStream.on('data', (data: Buffer) => {
      if (stderr.length < MAX_OUTPUT_BYTES) {
        stderr += data.toString();
      }
    });

    // Write stdin if provided
    if (invocation.stdin) {
      stdinStream.write(invocation.stdin);
      stdinStream.end();
    } else {
      stdinStream.end();
    }

    // Timeout: SIGTERM the process group first, SIGKILL after grace period
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child, 'SIGTERM');
      killTimer = setTimeout(() => {
        if (!killed) {
          killProcessGroup(child, 'SIGKILL');
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
  const result = await execute(
    {
      cmd: 'amp',
      args: ['usage'],
      cwd: process.cwd(),
    },
    10_000,
  );

  return result.exitCode === 0 ? result.stdout : null;
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
    binary: toolConfig.binary,
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

  // Build a shell-friendly command string for display
  const quote = (s: string) =>
    /[^a-zA-Z0-9_./:=@-]/.test(s) ? `'${s.replace(/'/g, "'\\''")}'` : s;
  const cmdStr = [invocation.cmd, ...invocation.args].map(quote).join(' ');
  const command =
    invocation.stdin != null
      ? `echo ${quote(invocation.stdin)} | ${cmdStr}`
      : cmdStr;

  const result = await execute(invocation, TEST_TIMEOUT);

  // Some CLIs (e.g. Codex) echo the prompt back as "User instructions: ..."
  // in their log output. If we see that, it means stdout contains CLI logging
  // rather than a clean model response — the "OK" match would be a false positive.
  const echoedPrompt = result.stdout.includes('User instructions');
  const passed =
    result.exitCode === 0 && result.stdout.includes('OK') && !echoedPrompt;

  let error: string | undefined;
  if (!passed) {
    if (result.timedOut) {
      error = `Timed out after ${TEST_TIMEOUT / 1000}s`;
    } else if (result.exitCode !== 0) {
      error =
        result.stderr.trim() || `Process exited with code ${result.exitCode}`;
    } else if (echoedPrompt) {
      error =
        'Tool echoed the prompt instead of a model response (check model access)';
    } else if (result.stderr.trim()) {
      error = result.stderr.slice(0, 500);
    } else {
      error = 'Output did not contain "OK"';
    }
  }

  return {
    toolId: toolName ?? adapter.id,
    passed,
    output: result.stdout.slice(0, 500),
    error,
    durationMs: Date.now() - start,
    command,
  };
}
