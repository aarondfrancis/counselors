import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { execute } from '../../src/core/executor.js';

describe('execute', () => {
  it('captures stdout', async () => {
    const result = await execute(
      {
        cmd: 'node',
        args: ['-e', 'process.stdout.write("hello world")'],
        cwd: process.cwd(),
      },
      5000,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello world');
    expect(result.timedOut).toBe(false);
  });

  it('captures stderr', async () => {
    const result = await execute(
      {
        cmd: 'node',
        args: ['-e', 'console.error("oops")'],
        cwd: process.cwd(),
      },
      5000,
    );

    expect(result.stderr.trim()).toBe('oops');
  });

  it('handles non-zero exit codes', async () => {
    const result = await execute(
      {
        cmd: 'node',
        args: ['-e', 'process.exit(42)'],
        cwd: process.cwd(),
      },
      5000,
    );

    expect(result.exitCode).toBe(42);
  });

  it('times out and kills', async () => {
    const result = await execute(
      {
        cmd: 'node',
        args: ['-e', 'setInterval(() => {}, 1000)'],
        cwd: process.cwd(),
      },
      500,
    );

    expect(result.timedOut).toBe(true);
  });

  it('handles stdin', async () => {
    const result = await execute(
      {
        cmd: 'node',
        args: [
          '-e',
          'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>process.stdout.write(d))',
        ],
        stdin: 'hello from stdin',
        cwd: process.cwd(),
      },
      5000,
    );

    expect(result.stdout).toBe('hello from stdin');
  });

  it('passes shell metacharacters as literal arguments', async () => {
    const literal = 'hello & world | test > output';
    const result = await execute(
      {
        cmd: 'node',
        args: ['-e', 'process.stdout.write(process.argv[1])', literal],
        cwd: process.cwd(),
      },
      5000,
    );

    expect(result.stdout).toBe(literal);
  });

  it('passes shell metacharacters literally through windows .cmd wrappers', async () => {
    if (process.platform !== 'win32') return;

    const testDir = mkdtempSync(join(tmpdir(), 'counselors-cmd-wrapper-'));
    const scriptPath = join(testDir, 'emit-ok.js');
    const cmdPath = join(testDir, 'echo-arg.cmd');
    const executedPath = join(testDir, 'executed.txt');
    const markerPath = join(testDir, 'injected.txt');

    try {
      writeFileSync(
        scriptPath,
        'require("node:fs").writeFileSync("executed.txt", "ok")',
        'utf-8',
      );
      writeFileSync(
        cmdPath,
        '@echo off\r\nnode "%~dp0emit-ok.js"\r\n',
        'utf-8',
      );

      // If metacharacters are interpreted by cmd.exe, this creates markerPath.
      const literal = `hello & type nul > "${markerPath}"`;
      const result = await execute(
        {
          cmd: cmdPath,
          args: [literal],
          cwd: testDir,
        },
        5000,
      );

      expect(result.exitCode).toBe(0);
      expect(existsSync(executedPath)).toBe(true);
      expect(existsSync(markerPath)).toBe(false);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('captures stdout through windows .cmd wrappers and prepends bin dir to PATH', async () => {
    if (process.platform !== 'win32') return;

    const testDir = mkdtempSync(join(tmpdir(), 'counselors-cmd-path-'));
    const scriptPath = join(testDir, 'print-path.js');
    const cmdPath = join(testDir, 'print-path.cmd');

    try {
      writeFileSync(
        scriptPath,
        'process.stdout.write(process.env.PATH || "")',
        'utf-8',
      );
      writeFileSync(
        cmdPath,
        `@echo off\r\n"${process.execPath}" "${scriptPath}"\r\n`,
        'utf-8',
      );

      // Keep PATH minimal so we can assert the injected prefix deterministically,
      // without mutating the test runner's process.env.
      const minimalPath = 'C:\\Windows\\System32';

      const result = await execute(
        {
          cmd: cmdPath,
          args: [],
          env: { PATH: minimalPath },
          cwd: testDir,
        },
        5000,
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout.startsWith(`${testDir}${delimiter}`)).toBe(true);
      expect(result.stdout).toContain(minimalPath);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('does not duplicate bin dir in PATH when PATH already contains it (trailing separator)', async () => {
    if (process.platform !== 'win32') return;

    const testDir = mkdtempSync(join(tmpdir(), 'counselors-cmd-path-dedupe-'));
    const scriptPath = join(testDir, 'print-path.js');
    const cmdPath = join(testDir, 'print-path.cmd');

    try {
      writeFileSync(
        scriptPath,
        'process.stdout.write(process.env.PATH || "")',
        'utf-8',
      );
      writeFileSync(
        cmdPath,
        `@echo off\r\n"${process.execPath}" "${scriptPath}"\r\n`,
        'utf-8',
      );

      const expectedPath = `${testDir}\\${delimiter}C:\\Windows\\System32`;

      const result = await execute(
        {
          cmd: cmdPath,
          args: [],
          env: { PATH: expectedPath },
          cwd: testDir,
        },
        5000,
      );

      expect(result.exitCode).toBe(0);
      // PATH should be unchanged (no duplicate injected prefix).
      expect(result.stdout).toBe(expectedPath);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('handles missing binary', async () => {
    const result = await execute(
      {
        cmd: 'nonexistent-binary-xyz',
        args: [],
        cwd: process.cwd(),
      },
      5000,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('ENOENT');
  });

  it('strips ANSI codes from output', async () => {
    const result = await execute(
      {
        cmd: 'node',
        args: ['-e', 'process.stdout.write("\\x1b[31mred\\x1b[0m")'],
        cwd: process.cwd(),
      },
      5000,
    );

    expect(result.stdout).toBe('red');
  });

  it('does not leak SECRET_KEY or other non-allowlisted env vars', async () => {
    // Set a secret in current process env
    process.env.SECRET_KEY = 'super-secret-value';
    try {
      const result = await execute(
        {
          cmd: 'node',
          args: [
            '-e',
            'process.stdout.write(process.env.SECRET_KEY || "NOT_SET")',
          ],
          cwd: process.cwd(),
        },
        5000,
      );

      expect(result.stdout).toBe('NOT_SET');
    } finally {
      delete process.env.SECRET_KEY;
    }
  });

  it('passes allowlisted env vars (HOME)', async () => {
    const result = await execute(
      {
        cmd: 'node',
        args: ['-e', 'process.stdout.write(process.env.HOME || "MISSING")'],
        cwd: process.cwd(),
      },
      5000,
    );

    expect(result.stdout).not.toBe('MISSING');
    expect(result.stdout).toBeTruthy();
  });

  it('merges invocation.env into child env', async () => {
    const result = await execute(
      {
        cmd: 'node',
        args: [
          '-e',
          'process.stdout.write(process.env.MY_TOOL_VAR || "MISSING")',
        ],
        env: { MY_TOOL_VAR: 'tool-specific' },
        cwd: process.cwd(),
      },
      5000,
    );

    expect(result.stdout).toBe('tool-specific');
  });

  it('passes API key env vars through to child processes', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.GEMINI_API_KEY = 'test-gemini-key';
    try {
      const result = await execute(
        {
          cmd: 'node',
          args: [
            '-e',
            'process.stdout.write([process.env.ANTHROPIC_API_KEY, process.env.OPENAI_API_KEY, process.env.GEMINI_API_KEY].join(","))',
          ],
          cwd: process.cwd(),
        },
        5000,
      );

      expect(result.stdout).toBe(
        'test-anthropic-key,test-openai-key,test-gemini-key',
      );
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;
      delete process.env.GEMINI_API_KEY;
    }
  });

  it('passes NVM_BIN through to child processes', async () => {
    process.env.NVM_BIN = '/fake/nvm/bin';
    try {
      const result = await execute(
        {
          cmd: 'node',
          args: [
            '-e',
            'process.stdout.write(process.env.NVM_BIN || "NOT_SET")',
          ],
          cwd: process.cwd(),
        },
        5000,
      );

      expect(result.stdout).toBe('/fake/nvm/bin');
    } finally {
      delete process.env.NVM_BIN;
    }
  });

  it('passes proxy env vars through to child processes', async () => {
    process.env.HTTP_PROXY = 'http://proxy:8080';
    process.env.HTTPS_PROXY = 'https://proxy:8443';
    process.env.NO_PROXY = 'localhost';
    try {
      const result = await execute(
        {
          cmd: 'node',
          args: [
            '-e',
            'process.stdout.write([process.env.HTTP_PROXY, process.env.HTTPS_PROXY, process.env.NO_PROXY].join(","))',
          ],
          cwd: process.cwd(),
        },
        5000,
      );

      expect(result.stdout).toBe(
        'http://proxy:8080,https://proxy:8443,localhost',
      );
    } finally {
      delete process.env.HTTP_PROXY;
      delete process.env.HTTPS_PROXY;
      delete process.env.NO_PROXY;
    }
  });

  it('passes GH_TOKEN and GITHUB_TOKEN through to child processes', async () => {
    process.env.GH_TOKEN = 'test-gh-token';
    process.env.GITHUB_TOKEN = 'test-github-token';
    try {
      const result = await execute(
        {
          cmd: 'node',
          args: [
            '-e',
            'process.stdout.write([process.env.GH_TOKEN, process.env.GITHUB_TOKEN].join(","))',
          ],
          cwd: process.cwd(),
        },
        5000,
      );

      expect(result.stdout).toBe('test-gh-token,test-github-token');
    } finally {
      delete process.env.GH_TOKEN;
      delete process.env.GITHUB_TOKEN;
    }
  });

  it('blocks NODE_OPTIONS from reaching child processes', async () => {
    process.env.NODE_OPTIONS = '--max-old-space-size=4096';
    try {
      const result = await execute(
        {
          cmd: 'node',
          args: [
            '-e',
            'process.stdout.write(process.env.NODE_OPTIONS || "NOT_SET")',
          ],
          cwd: process.cwd(),
        },
        5000,
      );

      expect(result.stdout).toBe('NOT_SET');
    } finally {
      delete process.env.NODE_OPTIONS;
    }
  });

  it('always sets CI=true and NO_COLOR=1', async () => {
    const result = await execute(
      {
        cmd: 'node',
        args: [
          '-e',
          'process.stdout.write(`${process.env.CI}:${process.env.NO_COLOR}`)',
        ],
        cwd: process.cwd(),
      },
      5000,
    );

    expect(result.stdout).toBe('true:1');
  });

  it('truncates stdout exceeding 10MB', async () => {
    // Generate ~11MB of output
    const result = await execute(
      {
        cmd: 'node',
        args: [
          '-e',
          `
        const chunk = 'x'.repeat(1024 * 1024); // 1MB
        for (let i = 0; i < 11; i++) process.stdout.write(chunk);
      `,
        ],
        cwd: process.cwd(),
      },
      15000,
    );

    // Should be capped near 10MB + truncation marker
    expect(result.stdout.length).toBeLessThan(11 * 1024 * 1024);
    expect(result.stdout).toContain('[output truncated at 10MB]');
  });

  it('kills process group on timeout so grandchildren do not outlive parent', async () => {
    if (process.platform === 'win32') return;

    const markerPath = join(
      tmpdir(),
      `counselors-orphan-${process.pid}-${Date.now()}.txt`,
    );

    const grandchildScript = `
const fs = require('node:fs');
setTimeout(() => {
  fs.writeFileSync(${JSON.stringify(markerPath)}, 'orphan');
  process.exit(0);
}, 2000);
setInterval(() => {}, 1000);
`;

    const parentScript = `
const { spawn } = require('node:child_process');
spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], {
  stdio: 'ignore',
});
setInterval(() => {}, 1000);
`;

    try {
      const result = await execute(
        {
          cmd: 'node',
          args: ['-e', parentScript],
          cwd: process.cwd(),
        },
        300,
      );

      expect(result.timedOut).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 2500));
      expect(existsSync(markerPath)).toBe(false);
    } finally {
      rmSync(markerPath, { force: true });
    }
  });
});
