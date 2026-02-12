import { execFileSync } from 'node:child_process';
import {
  accessSync,
  constants,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  DISCOVERY_TIMEOUT,
  getExtendedSearchPaths,
  VERSION_TIMEOUT,
} from '../constants.js';
import type { DiscoveryResult } from '../types.js';

/**
 * Two-stage binary discovery:
 * 1. `which <command>` via execSync
 * 2. Manual scan of extended paths
 */
export function findBinary(command: string): string | null {
  // Stage 1: which (Unix) / where (Windows)
  const lookupCmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const result = execFileSync(lookupCmd, [command], {
      timeout: DISCOVERY_TIMEOUT,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    })
      .trim()
      .split('\n')[0]
      .trim(); // `where` on Windows may return multiple lines
    if (result) return result;
  } catch {
    // not found via lookup, continue to stage 2
  }

  // Stage 2: extended path scan
  const searchPaths = [
    ...getExtendedSearchPaths(),
    ...getNvmPaths(),
    ...getFnmPaths(),
  ];

  for (const dir of searchPaths) {
    const fullPath = join(dir, command);
    try {
      accessSync(fullPath, constants.X_OK);
      return fullPath;
    } catch {
      // not found here, continue
    }
  }

  return null;
}

/**
 * Get NVM version bin directories by resolving the default alias.
 */
function getNvmPaths(): string[] {
  const home = homedir();
  const nvmDir = join(home, '.nvm');
  const aliasFile = join(nvmDir, 'alias', 'default');

  if (!existsSync(aliasFile)) return [];

  try {
    let alias = readFileSync(aliasFile, 'utf-8').trim();

    // Resolve LTS aliases: lts/iron -> read ~/.nvm/alias/lts/iron
    if (alias.startsWith('lts/')) {
      const ltsName = alias.slice(4);
      const ltsFile = join(nvmDir, 'alias', 'lts', ltsName);
      if (existsSync(ltsFile)) {
        alias = readFileSync(ltsFile, 'utf-8').trim();
      }
    }

    // Find matching version directory
    const versionsDir = join(nvmDir, 'versions', 'node');
    if (!existsSync(versionsDir)) return [];

    const versions = readdirSync(versionsDir);
    const match = versions.find((v) => v.startsWith(`v${alias}`));
    if (match) {
      return [join(versionsDir, match, 'bin')];
    }
  } catch {
    // nvm parsing failed, skip
  }

  return [];
}

/**
 * Get FNM multishell bin directories (5 most recent by mtime).
 */
function getFnmPaths(): string[] {
  const home = homedir();
  const multishellDir = join(home, '.local', 'state', 'fnm_multishells');
  const paths: string[] = [];

  // Also check fnm alias dirs
  const fnmDir = join(home, '.local', 'share', 'fnm');
  if (existsSync(fnmDir)) {
    const aliasDir = join(fnmDir, 'aliases');
    if (existsSync(aliasDir)) {
      try {
        for (const alias of readdirSync(aliasDir)) {
          const binDir = join(aliasDir, alias, 'bin');
          if (existsSync(binDir)) paths.push(binDir);
        }
      } catch {
        // skip
      }
    }
  }

  if (!existsSync(multishellDir)) return paths;

  try {
    const entries = readdirSync(multishellDir)
      .map((name) => {
        const full = join(multishellDir, name);
        try {
          return { name: full, mtime: statSync(full).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((e): e is { name: string; mtime: number } => e !== null)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 5);

    for (const entry of entries) {
      const binDir = join(entry.name, 'bin');
      if (existsSync(binDir)) {
        paths.push(binDir);
      }
    }
  } catch {
    // scan failed, skip
  }

  return paths;
}

/**
 * Get binary version via --version flag.
 */
export function getBinaryVersion(binaryPath: string): string | null {
  try {
    const output = execFileSync(binaryPath, ['--version'], {
      timeout: VERSION_TIMEOUT,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
      shell: process.platform === "win32",
    }).trim();
    // Take first line, strip common prefixes
    const firstLine = output.split('\n')[0].trim();
    return firstLine || null;
  } catch {
    return null;
  }
}

/**
 * Discover a single tool.
 */
export function discoverTool(
  commands: string[],
): DiscoveryResult & { command: string } {
  for (const cmd of commands) {
    const path = findBinary(cmd);
    if (path) {
      const version = getBinaryVersion(path);
      return { toolId: cmd, found: true, path, version, command: cmd };
    }
  }
  return {
    toolId: commands[0],
    found: false,
    path: null,
    version: null,
    command: commands[0],
  };
}
