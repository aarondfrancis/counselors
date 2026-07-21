import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../src/types.js';

// We test the dispatch function with a mock executor
vi.mock('../../src/core/executor.js', () => ({
  execute: vi
    .fn()
    .mockImplementation(
      (
        _inv: any,
        _timeout: any,
        onSpawn?: (pid: number | undefined) => void,
      ) => {
        onSpawn?.(12345);
        return Promise.resolve({
          exitCode: 0,
          stdout: 'mock output',
          stderr: '',
          timedOut: false,
          durationMs: 100,
        });
      },
    ),
  captureAmpUsage: vi.fn().mockResolvedValue(null),
  computeAmpCostFromSnapshots: vi.fn().mockReturnValue(null),
}));

const { dispatch } = await import('../../src/core/dispatcher.js');

const testDir = join(tmpdir(), `counselors-dispatch-test-${Date.now()}`);

beforeEach(() => {
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function makeConfig(tools: Config['tools']): Config {
  return {
    version: 1,
    defaults: {
      timeout: 10,
      outputDir: testDir,
      readOnly: 'bestEffort',
      maxContextKb: 50,
      maxParallel: 4,
    },
    tools,
    groups: {},
  };
}

describe('dispatch', () => {
  it('throws when zero tools are eligible', async () => {
    const config = makeConfig({
      'my-custom': {
        binary: '/usr/bin/custom',
        readOnly: { level: 'bestEffort' },
        custom: true,
      },
    });

    await expect(
      dispatch({
        config,
        toolIds: ['my-custom'],
        promptFilePath: '/tmp/prompt.md',
        promptContent: 'test',
        outputDir: testDir,
        readOnlyPolicy: 'enforced', // custom tool is bestEffort, so it gets filtered out
        cwd: process.cwd(),
      }),
    ).rejects.toThrow('No eligible tools after read-only policy filtering.');
  });

  it('sanitizes tool IDs with path traversal characters', async () => {
    const config = makeConfig({
      '../evil': {
        binary: '/usr/bin/echo',
        readOnly: { level: 'enforced' },
      },
    });

    const reports = await dispatch({
      config,
      toolIds: ['../evil'],
      promptFilePath: '/tmp/prompt.md',
      promptContent: 'test',
      outputDir: testDir,
      readOnlyPolicy: 'none',
      cwd: process.cwd(),
    });

    expect(reports).toHaveLength(1);
    // Output file should use sanitized ID: ../evil → .._evil
    expect(reports[0].outputFile).toContain('.._evil.md');
    expect(reports[0].outputFile).not.toContain('/../');
  });

  it('calls onProgress with started and completed events', async () => {
    const config = makeConfig({
      claude: {
        binary: '/usr/bin/claude',
        readOnly: { level: 'enforced' },
      },
    });

    const events: { toolId: string; event: string }[] = [];

    await dispatch({
      config,
      toolIds: ['claude'],
      promptFilePath: '/tmp/prompt.md',
      promptContent: 'test',
      outputDir: testDir,
      readOnlyPolicy: 'none',
      cwd: process.cwd(),
      onProgress: (e) => events.push({ toolId: e.toolId, event: e.event }),
    });

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ toolId: 'claude', event: 'started' });
    expect(events[1]).toMatchObject({ toolId: 'claude', event: 'completed' });
  });

  it('includes pid in started progress event', async () => {
    const config = makeConfig({
      claude: {
        binary: '/usr/bin/claude',
        readOnly: { level: 'enforced' },
      },
    });

    let startedPid: number | undefined;

    await dispatch({
      config,
      toolIds: ['claude'],
      promptFilePath: '/tmp/prompt.md',
      promptContent: 'test',
      outputDir: testDir,
      readOnlyPolicy: 'none',
      cwd: process.cwd(),
      onProgress: (e) => {
        if (e.event === 'started') startedPid = e.pid;
      },
    });

    expect(startedPid).toBe(12345);
  });

  it('includes report in completed progress event', async () => {
    const config = makeConfig({
      claude: {
        binary: '/usr/bin/claude',
        readOnly: { level: 'enforced' },
      },
    });

    let completedReport: any = null;

    await dispatch({
      config,
      toolIds: ['claude'],
      promptFilePath: '/tmp/prompt.md',
      promptContent: 'test',
      outputDir: testDir,
      readOnlyPolicy: 'none',
      cwd: process.cwd(),
      onProgress: (e) => {
        if (e.event === 'completed') completedReport = e.report;
      },
    });

    expect(completedReport).not.toBeNull();
    expect(completedReport.toolId).toBe('claude');
    expect(completedReport.status).toBe('success');
  });

  it('works without onProgress callback', async () => {
    const config = makeConfig({
      claude: {
        binary: '/usr/bin/claude',
        readOnly: { level: 'enforced' },
      },
    });

    const reports = await dispatch({
      config,
      toolIds: ['claude'],
      promptFilePath: '/tmp/prompt.md',
      promptContent: 'test',
      outputDir: testDir,
      readOnlyPolicy: 'none',
      cwd: process.cwd(),
    });

    expect(reports).toHaveLength(1);
    expect(reports[0].status).toBe('success');
  });

  it('passes extraFlags from tool config to adapter', async () => {
    const { execute } = await import('../../src/core/executor.js');
    const mockExecute = vi.mocked(execute);

    const config = makeConfig({
      'claude-opus': {
        binary: '/usr/bin/claude',
        readOnly: { level: 'enforced' },
        adapter: 'claude',
        extraFlags: ['--model', 'opus'],
      },
    });

    await dispatch({
      config,
      toolIds: ['claude-opus'],
      promptFilePath: '/tmp/prompt.md',
      promptContent: 'test',
      outputDir: testDir,
      readOnlyPolicy: 'none',
      cwd: process.cwd(),
    });

    const [invocation] = mockExecute.mock.calls.at(-1)!;
    expect(invocation.args).toContain('--model');
    expect(invocation.args).toContain('opus');
  });

  it('filters tools by read-only policy', async () => {
    const config = makeConfig({
      claude: {
        binary: '/usr/bin/claude',
        readOnly: { level: 'enforced' },
      },
      gemini: {
        binary: '/usr/bin/gemini',
        readOnly: { level: 'bestEffort' },
      },
    });

    // With none policy, all tools should be eligible
    const reports = await dispatch({
      config,
      toolIds: ['claude', 'gemini'],
      promptFilePath: '/tmp/prompt.md',
      promptContent: 'test',
      outputDir: testDir,
      readOnlyPolicy: 'none',
      cwd: process.cwd(),
    });

    expect(reports).toHaveLength(2);
  });

  it('uses adapter parseResult for status and wordCount', async () => {
    // The mock executor returns exitCode: 0, stdout: 'mock output'.
    // BaseAdapter.parseResult computes status: 'success', wordCount: 2.
    // Dispatcher defaults are status: 'error', wordCount: 0.
    // Adapter's values should win via ...parsed spread.
    const config = makeConfig({
      claude: {
        binary: '/usr/bin/claude',
        readOnly: { level: 'enforced' },
      },
    });

    const reports = await dispatch({
      config,
      toolIds: ['claude'],
      promptFilePath: '/tmp/prompt.md',
      promptContent: 'test',
      outputDir: testDir,
      readOnlyPolicy: 'none',
      cwd: process.cwd(),
    });

    expect(reports[0].status).toBe('success'); // from adapter, not dispatcher default 'error'
    expect(reports[0].wordCount).toBe(2); // from adapter, not dispatcher default 0
  });

  it('dispatcher-only fields are not overridden by adapter', async () => {
    const config = makeConfig({
      claude: {
        binary: '/usr/bin/claude',
        readOnly: { level: 'enforced' },
      },
    });

    const reports = await dispatch({
      config,
      toolIds: ['claude'],
      promptFilePath: '/tmp/prompt.md',
      promptContent: 'test',
      outputDir: testDir,
      readOnlyPolicy: 'none',
      cwd: process.cwd(),
    });

    // outputFile and stderrFile are set by dispatcher, not adapter
    expect(reports[0].outputFile).toContain('claude.md');
    expect(reports[0].stderrFile).toContain('claude.stderr');
    // No error for successful runs
    expect(reports[0].error).toBeUndefined();
  });

  it('prefers an adapter-supplied error over the exitCode-based default', async () => {
    // A tool can exit 0 while its own parseResult still detects a failure
    // (e.g. antigravity's exit-0-on-permission-denial case) — its error
    // message must survive the dispatcher-only-fields spread, not just its
    // status.
    const { execute } = await import('../../src/core/executor.js');
    vi.mocked(execute).mockResolvedValueOnce({
      exitCode: 0,
      stdout: '',
      stderr: 'jetski: no output produced — permission denied',
      timedOut: false,
      durationMs: 50,
    });

    const config = makeConfig({
      antigravity: {
        binary: '/usr/bin/agy',
        readOnly: { level: 'enforced' },
      },
    });

    const reports = await dispatch({
      config,
      toolIds: ['antigravity'],
      promptFilePath: '/tmp/prompt.md',
      promptContent: 'test',
      outputDir: testDir,
      readOnlyPolicy: 'none',
      cwd: process.cwd(),
    });

    expect(reports[0].status).toBe('error');
    expect(reports[0].error).toContain('read_file');
  });

  it('skips amp-deep under enforced read-only policy', async () => {
    const config = makeConfig({
      'amp-deep': {
        binary: '/usr/bin/amp',
        adapter: 'amp',
        readOnly: { level: 'enforced' },
        extraFlags: ['-m', 'deep'],
      },
      claude: {
        binary: '/usr/bin/claude',
        readOnly: { level: 'enforced' },
      },
    });

    const reports = await dispatch({
      config,
      toolIds: ['amp-deep', 'claude'],
      promptFilePath: '/tmp/prompt.md',
      promptContent: 'test',
      outputDir: testDir,
      readOnlyPolicy: 'enforced',
      cwd: process.cwd(),
    });

    // amp-deep should be filtered out (bestEffort effective level)
    expect(reports).toHaveLength(1);
    expect(reports[0].toolId).toBe('claude');
  });
});
