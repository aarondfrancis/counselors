import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { CONFIG_FILE_MODE, sanitizePath } from '../constants.js';
import { safeWriteFile } from '../core/fs-utils.js';
import type {
  ExecResult,
  Invocation,
  ReadOnlyLevel,
  RunRequest,
  ToolConfig,
  ToolReport,
} from '../types.js';
import { BaseAdapter } from './base.js';

export const ANTIGRAVITY_SETTINGS_FILE = join(
  homedir(),
  '.gemini',
  'antigravity-cli',
  'settings.json',
);

const READ_ONLY_RULE = 'read_file(*)';
const DENIED_STDERR_MARKER = 'jetski: no output produced';
// Any of these grant more than a read — if the user's own interactive agy
// use has accumulated one in the shared settings file, headless runs
// inherit it too, so 'enforced' can no longer be claimed for this tool.
const NON_READ_ONLY_RULE_PREFIXES = ['write_file(', 'command(', 'unsandboxed('];

/**
 * Reads and validates the shape of the shared settings file.
 * Returns {} if it doesn't exist yet. Returns undefined if it exists but
 * isn't parseable JSON or isn't a plain object — callers decide how to
 * react (ensureAntigravityReadOnlySettings treats that as a hard stop;
 * getEffectiveReadOnlyLevel treats "can't verify" as "can't claim enforced").
 */
function readAntigravitySettingsRaw(): Record<string, unknown> | undefined {
  if (!existsSync(ANTIGRAVITY_SETTINGS_FILE)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(ANTIGRAVITY_SETTINGS_FILE, 'utf-8'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  return parsed as Record<string, unknown>;
}

/**
 * Grants headless read access to paths outside the review workspace.
 *
 * Reads inside the --add-dir workspace need no rule at all (verified live).
 * This rule exists for reads OUTSIDE it — which counselors genuinely needs,
 * since the prompt file itself is written to an os.tmpdir() directory
 * (prompt-writer.ts) and loop.ts's discovery/prompt-writing phases can run
 * through an antigravity tool.
 *
 * Unlike amp, agy has no --settings-file override — the only way to grant
 * this is the user's real, shared global settings file, so this reads,
 * merges, and writes back rather than overwriting: it holds the user's
 * other Antigravity preferences (colorScheme, telemetry, etc.) and may
 * already carry other permission rules that must survive untouched.
 */
export function ensureAntigravityReadOnlySettings(): void {
  const settings = readAntigravitySettingsRaw();
  if (settings === undefined) {
    throw new Error(
      `${ANTIGRAVITY_SETTINGS_FILE} exists but isn't a valid JSON object — fix or remove it, then retry.`,
    );
  }

  const permissions = (settings.permissions ?? {}) as { allow?: unknown };
  const allow = Array.isArray(permissions.allow) ? permissions.allow : [];
  if (allow.includes(READ_ONLY_RULE)) return;

  const updated = {
    ...settings,
    permissions: { ...permissions, allow: [...allow, READ_ONLY_RULE] },
  };

  mkdirSync(dirname(ANTIGRAVITY_SETTINGS_FILE), { recursive: true });
  safeWriteFile(
    ANTIGRAVITY_SETTINGS_FILE,
    `${JSON.stringify(updated, null, 2)}\n`,
    { mode: CONFIG_FILE_MODE },
  );
}

/** agy exits 0 even when headless mode auto-denies a tool permission. */
export function isAntigravityPermissionDenied(stderr: string): boolean {
  return stderr.includes(DENIED_STDERR_MARKER);
}

export class AntigravityAdapter extends BaseAdapter {
  id = 'antigravity';
  displayName = 'Antigravity CLI';
  commands = ['agy'];
  installUrl = 'https://antigravity.google/docs/cli/install';
  // Backed by a settings.json permissions.allow grant + exit-0 denial
  // detection in parseResult below, NOT by --sandbox (verified: --sandbox
  // alone does not block writes inside the working directory).
  // getEffectiveReadOnlyLevel downgrades this if that grant turns out to
  // be sitting alongside a write-capable rule in the user's shared config.
  readOnly = { level: 'enforced' as const };
  modelFlag = '--model';
  models = [
    {
      id: 'gemini-3.6-flash-high',
      compoundId: 'antigravity-flash-high',
      name: 'Gemini 3.6 Flash — latest, high reasoning',
      recommended: true,
      extraFlags: ['--model', 'gemini-3.6-flash-high'],
    },
    {
      id: 'gemini-3.1-pro-high',
      compoundId: 'antigravity-pro-high',
      name: 'Gemini 3.1 Pro — established flagship',
      extraFlags: ['--model', 'gemini-3.1-pro-high'],
    },
  ];

  getEffectiveReadOnlyLevel(_toolConfig: ToolConfig): ReadOnlyLevel {
    const settings = readAntigravitySettingsRaw();
    // Can't verify the shared grant is clean — don't claim enforced.
    if (settings === undefined) return 'bestEffort';

    const allow = (settings.permissions as { allow?: unknown } | undefined)
      ?.allow;
    const hasWriteCapableRule =
      Array.isArray(allow) &&
      allow.some(
        (rule) =>
          typeof rule === 'string' &&
          NON_READ_ONLY_RULE_PREFIXES.some((prefix) => rule.startsWith(prefix)),
      );

    return hasWriteCapableRule ? 'bestEffort' : this.readOnly.level;
  }

  buildInvocation(req: RunRequest): Invocation {
    const instruction = `Read the file at ${sanitizePath(req.promptFilePath)} and follow the instructions within it.`;
    const args: string[] = [];

    if (req.readOnlyPolicy !== 'none') {
      args.push('--sandbox');
    }

    // Headless mode otherwise resolves "current directory" to agy's own
    // scratch dir rather than req.cwd, so this fixes path resolution for
    // the repo under review (not a read-permission grant on its own).
    args.push('--add-dir', req.cwd);

    // agy's own --print-timeout defaults to 5 minutes and silently caps
    // the run there regardless of counselors' configured timeout — set it
    // past req.timeout so counselors' own executor timeout fires first and
    // the run is classified as 'timeout', not a generic 'error'.
    args.push('--print-timeout', `${req.timeout + 60}s`);

    if (req.extraFlags) {
      args.push(...req.extraFlags);
    }

    args.push('-p', instruction);

    return { cmd: req.binary ?? 'agy', args, cwd: req.cwd };
  }

  parseResult(result: ExecResult): Partial<ToolReport> {
    const base = super.parseResult(result);

    // agy exits 0 on a denied headless permission, so an empty response on
    // a "successful" exit is itself the failure signal — more robust than
    // matching the denial marker text alone, which could drift across agy
    // versions. The marker only enriches the message when it's present.
    const emptyOnCleanExit =
      !result.timedOut && result.exitCode === 0 && result.stdout.trim() === '';

    if (emptyOnCleanExit) {
      return {
        ...base,
        status: 'error',
        error: isAntigravityPermissionDenied(result.stderr)
          ? `agy denied a tool permission in headless mode — re-run "counselors init" (or "tools add") to restore the ${READ_ONLY_RULE} grant in ${ANTIGRAVITY_SETTINGS_FILE}.`
          : 'agy exited cleanly but produced no output.',
      };
    }

    return base;
  }
}
