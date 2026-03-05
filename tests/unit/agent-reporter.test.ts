import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolReport } from '../../src/types.js';

let stderrOutput: string;
let stdoutOutput: string;
const originalStderrWrite = process.stderr.write;
const originalStdoutWrite = process.stdout.write;

beforeEach(() => {
  stderrOutput = '';
  stdoutOutput = '';
  process.stderr.write = vi.fn((chunk: any) => {
    stderrOutput += typeof chunk === 'string' ? chunk : chunk.toString();
    return true;
  }) as any;
  process.stdout.write = vi.fn((chunk: any) => {
    stdoutOutput += typeof chunk === 'string' ? chunk : chunk.toString();
    return true;
  }) as any;
});

afterEach(() => {
  process.stderr.write = originalStderrWrite;
  process.stdout.write = originalStdoutWrite;
});

async function createReporter() {
  const { AgentReporter } = await import('../../src/ui/agent-reporter.js');
  return new AgentReporter();
}

function makeReport(overrides: Partial<ToolReport> = {}): ToolReport {
  return {
    toolId: 'test-tool',
    status: 'success',
    exitCode: 0,
    durationMs: 5000,
    wordCount: 100,
    outputFile: '/tmp/test.md',
    stderrFile: '/tmp/test.stderr',
    ...overrides,
  };
}

describe('AgentReporter phases', () => {
  it('prints discovery started/completed', async () => {
    const r = await createReporter();
    r.discoveryStarted('claude');
    expect(stderrOutput).toContain('Discovery phase: claude');
    r.discoveryCompleted('claude');
    expect(stderrOutput).toContain('Discovery complete');
  });

  it('prints prompt-writing started/completed', async () => {
    const r = await createReporter();
    r.promptWritingStarted('claude');
    expect(stderrOutput).toContain('Prompt-writing phase: claude');
    r.promptWritingCompleted('claude');
    expect(stderrOutput).toContain('Prompt-writing complete');
  });

  it('prints phase PID line', async () => {
    const r = await createReporter();
    r.phasePidReported('claude', 82795);
    expect(stderrOutput).toContain('PID 82795');
    expect(stderrOutput).toContain('claude');
    expect(stderrOutput).toContain('(phase)');
  });
});

describe('AgentReporter execution', () => {
  it('prints output dir and PID on executionStarted', async () => {
    const r = await createReporter();
    r.executionStarted('/tmp/output', ['claude']);
    expect(stderrOutput).toContain('Output: /tmp/output');
    expect(stderrOutput).toContain(`PID: ${process.pid}`);
    expect(stderrOutput).toContain('This may take more than 10 minutes');
    r.executionFinished();
  });

  it('passes through paths as-is', async () => {
    const r = await createReporter();
    r.executionStarted('/abs/agents/counselors/test', ['claude']);
    expect(stderrOutput).toContain('Output: /abs/agents/counselors/test');
    r.executionFinished();
  });

  it('prints started message with PID', async () => {
    const r = await createReporter();
    r.executionStarted('/tmp/output', ['claude']);
    stderrOutput = '';
    r.toolStarted('claude', 42);
    expect(stderrOutput).toContain('PID 42  claude started');
    r.executionFinished();
  });

  it('prints started message without PID', async () => {
    const r = await createReporter();
    r.executionStarted('/tmp/output', ['claude']);
    stderrOutput = '';
    r.toolStarted('claude');
    expect(stderrOutput).toContain('claude started');
    expect(stderrOutput).not.toMatch(/PID \d+\s+claude started/);
    r.executionFinished();
  });

  it('prints completed message with duration and word count', async () => {
    const r = await createReporter();
    r.executionStarted('/tmp/output', ['claude']);
    r.toolStarted('claude');
    r.toolCompleted(
      'claude',
      makeReport({ toolId: 'claude', durationMs: 12300, wordCount: 500 }),
    );
    expect(stderrOutput).toContain('claude done');
    expect(stderrOutput).toContain('12.3s');
    expect(stderrOutput).toContain('500 words');
    r.executionFinished();
  });

  it('prints stderr file path for failed tools', async () => {
    const r = await createReporter();
    r.executionStarted('/tmp/output', ['gemini']);
    r.toolStarted('gemini');
    r.toolCompleted(
      'gemini',
      makeReport({
        toolId: 'gemini',
        status: 'error',
        exitCode: 1,
        stderrFile: '/tmp/output/gemini.stderr',
      }),
    );
    expect(stderrOutput).toContain('gemini done');
    expect(stderrOutput).toContain('see /tmp/output/gemini.stderr');
    r.executionFinished();
  });

  it('prints timeout icon for timed-out tools', async () => {
    const r = await createReporter();
    r.executionStarted('/tmp/output', ['slow']);
    r.toolStarted('slow');
    r.toolCompleted('slow', makeReport({ toolId: 'slow', status: 'timeout' }));
    expect(stderrOutput).toContain('slow done');
    r.executionFinished();
  });

  it('ignores unknown tool IDs', async () => {
    const r = await createReporter();
    r.executionStarted('/tmp/output', ['claude']);
    // Should not throw
    r.toolStarted('nonexistent');
    r.toolCompleted('nonexistent', makeReport());
    r.executionFinished();
  });
});

describe('AgentReporter rounds', () => {
  it('prints round header', async () => {
    const r = await createReporter();
    r.executionStarted('/tmp/output', ['claude']);
    r.roundStarted(1, 3);
    expect(stderrOutput).toContain('Round 1/3');
    r.executionFinished();
  });

  it('prints convergence message', async () => {
    const r = await createReporter();
    r.executionStarted('/tmp/output', ['claude']);
    r.convergenceDetected(2, 0.15, 0.3);
    expect(stderrOutput).toContain('Convergence at round 2');
    expect(stderrOutput).toContain('0.15');
    expect(stderrOutput).toContain('0.3');
    r.executionFinished();
  });

  it('resets tool states so subsequent round tool events work', async () => {
    const r = await createReporter();
    r.executionStarted('/tmp/output', ['claude']);
    r.toolStarted('claude', 100);
    r.toolCompleted('claude', makeReport({ toolId: 'claude' }));

    // Start round 2 — should reset tools
    r.roundStarted(2, 3);
    stderrOutput = '';

    // Same tool ID should work again after reset
    r.toolStarted('claude', 200);
    expect(stderrOutput).toContain('PID 200  claude started');
    r.toolCompleted(
      'claude',
      makeReport({ toolId: 'claude', durationMs: 8000, wordCount: 300 }),
    );
    expect(stderrOutput).toContain('claude done');
    expect(stderrOutput).toContain('300 words');
    r.executionFinished();
  });

  it('handles multiple tools across rounds', async () => {
    const r = await createReporter();
    r.executionStarted('/tmp/output', ['claude', 'codex']);
    r.toolStarted('claude', 111);
    r.toolStarted('codex', 222);
    r.toolCompleted('claude', makeReport({ toolId: 'claude' }));
    r.toolCompleted('codex', makeReport({ toolId: 'codex' }));
    stderrOutput = '';

    r.roundStarted(2, 3);
    expect(stderrOutput).toContain('Round 2/3');

    r.toolStarted('claude', 333);
    r.toolStarted('codex', 444);
    expect(stderrOutput).toContain('PID 333  claude started');
    expect(stderrOutput).toContain('PID 444  codex started');
    r.executionFinished();
  });

  it('shows elapsed time and Ctrl+C hint between rounds', async () => {
    vi.useFakeTimers();
    const r = await createReporter();
    r.executionStarted('/tmp/output', ['claude']);
    r.roundStarted(1, 3);
    vi.advanceTimersByTime(90_000); // 1m 30s
    stderrOutput = '';
    r.roundStarted(2, 3);
    expect(stderrOutput).toContain('1m 30s elapsed');
    expect(stderrOutput).toContain('Ctrl+C to stop');
    expect(stderrOutput).toContain('Round 2/3');
    r.executionFinished();
    vi.useRealTimers();
  });

  it('shows remaining time when durationMs is set', async () => {
    vi.useFakeTimers();
    const r = await createReporter();
    r.executionStarted('/tmp/output', ['claude'], { durationMs: 300_000 });
    r.roundStarted(1, 3);
    vi.advanceTimersByTime(120_000); // 2m elapsed, 3m remaining
    stderrOutput = '';
    r.roundStarted(2, 3);
    expect(stderrOutput).toContain('2m 0s elapsed');
    expect(stderrOutput).toContain('~3m 0s remaining');
    r.executionFinished();
    vi.useRealTimers();
  });

  it('does not show timing on round 1', async () => {
    const r = await createReporter();
    r.executionStarted('/tmp/output', ['claude']);
    stderrOutput = '';
    r.roundStarted(1, 3);
    expect(stderrOutput).not.toContain('elapsed');
    expect(stderrOutput).not.toContain('Ctrl+C');
    expect(stderrOutput).toContain('Round 1/3');
    r.executionFinished();
  });
});

describe('AgentReporter round delay', () => {
  it('prints delay message with round label and duration', async () => {
    const r = await createReporter();
    r.executionStarted('/tmp/output', ['claude']);
    r.roundStarted(1, 3);
    stderrOutput = '';

    r.roundDelayStarted(2, 30_000);
    expect(stderrOutput).toContain('Round 2/3: starting after 30s');
    expect(stderrOutput).toContain('Ctrl+C to stop');
    r.executionFinished();
  });

  it('uses Math.ceil so sub-second values never show 0s', async () => {
    const r = await createReporter();
    r.executionStarted('/tmp/output', ['claude']);
    r.roundStarted(1, 3);
    stderrOutput = '';

    r.roundDelayStarted(2, 500);
    expect(stderrOutput).toContain('1s');
    expect(stderrOutput).not.toContain('0s');
    r.executionFinished();
  });

  it('renders round label without total when totalRounds is null', async () => {
    const r = await createReporter();
    r.executionStarted('/tmp/output', ['claude']);
    r.roundStarted(1, null);
    stderrOutput = '';

    r.roundDelayStarted(2, 10_000);
    expect(stderrOutput).toContain('Round 2: starting after');
    expect(stderrOutput).not.toContain('Round 2/');
    r.executionFinished();
  });

  it('roundDelayEnded does not throw', async () => {
    const r = await createReporter();
    r.executionStarted('/tmp/output', ['claude']);
    expect(() => r.roundDelayEnded()).not.toThrow();
    r.executionFinished();
  });
});

describe('AgentReporter heartbeat', () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('emits first heartbeat at 60s with elapsed time', async () => {
    vi.useFakeTimers();
    const r = await createReporter();
    r.executionStarted('/tmp/output', ['claude']);
    r.toolStarted('claude');
    stderrOutput = '';

    vi.advanceTimersByTime(59_999);
    expect(stderrOutput).not.toContain('heartbeat');

    vi.advanceTimersByTime(1);
    expect(stderrOutput).toContain('heartbeat: 1m 0s elapsed');

    r.executionFinished();
  });

  it('includes active PIDs in heartbeat', async () => {
    vi.useFakeTimers();
    const r = await createReporter();
    r.executionStarted('/tmp/output', ['claude', 'codex']);
    r.toolStarted('claude', 111);
    r.toolStarted('codex', 222);
    stderrOutput = '';

    vi.advanceTimersByTime(60_000);
    expect(stderrOutput).toContain('(PIDs: 111, 222)');

    r.executionFinished();
  });

  it('excludes completed tools from PID list', async () => {
    vi.useFakeTimers();
    const r = await createReporter();
    r.executionStarted('/tmp/output', ['claude', 'codex']);
    r.toolStarted('claude', 111);
    r.toolStarted('codex', 222);
    r.toolCompleted('claude', makeReport({ toolId: 'claude' }));
    stderrOutput = '';

    vi.advanceTimersByTime(60_000);
    expect(stderrOutput).toContain('(PIDs: 222)');
    expect(stderrOutput).not.toContain('111');

    r.executionFinished();
  });

  it('stop clears heartbeat so no further output appears', async () => {
    vi.useFakeTimers();
    const r = await createReporter();
    r.executionStarted('/tmp/output', ['claude']);
    r.toolStarted('claude');
    r.executionFinished();
    stderrOutput = '';

    vi.advanceTimersByTime(120_000);
    expect(stderrOutput).not.toContain('heartbeat');
  });

  it('formats multi-minute elapsed time', async () => {
    vi.useFakeTimers();
    const r = await createReporter();
    r.executionStarted('/tmp/output', ['claude']);
    r.toolStarted('claude');
    stderrOutput = '';

    vi.advanceTimersByTime(120_000);
    expect(stderrOutput).toContain('heartbeat: 2m 0s elapsed');

    r.executionFinished();
  });

  it('omits PID list when no tools have PIDs', async () => {
    vi.useFakeTimers();
    const r = await createReporter();
    r.executionStarted('/tmp/output', ['claude']);
    r.toolStarted('claude');
    stderrOutput = '';

    vi.advanceTimersByTime(60_000);
    expect(stderrOutput).toContain('heartbeat:');
    expect(stderrOutput).not.toContain('PIDs');

    r.executionFinished();
  });

  it('does not start multiple heartbeats for multiple toolStarted calls', async () => {
    vi.useFakeTimers();
    const r = await createReporter();
    r.executionStarted('/tmp/output', ['claude', 'codex']);
    r.toolStarted('claude');
    r.toolStarted('codex');
    stderrOutput = '';

    vi.advanceTimersByTime(60_000);
    const heartbeats = stderrOutput.match(/heartbeat:/g);
    expect(heartbeats).toHaveLength(1);

    r.executionFinished();
  });
});

describe('AgentReporter printSummary', () => {
  it('writes JSON to stdout when json option is set', async () => {
    const r = await createReporter();
    const manifest = {
      timestamp: '2024-01-01T00:00:00Z',
      slug: 'test',
      prompt: 'test',
      promptSource: 'inline' as const,
      readOnlyPolicy: 'none' as const,
      tools: [],
    };
    r.printSummary(manifest, { json: true });
    expect(stdoutOutput).toContain('"slug": "test"');
  });

  it('writes formatted summary to stdout when json is not set', async () => {
    const r = await createReporter();
    const manifest = {
      timestamp: '2024-01-01T00:00:00Z',
      slug: 'test-run',
      prompt: 'test',
      promptSource: 'inline' as const,
      readOnlyPolicy: 'none' as const,
      tools: [
        makeReport({
          toolId: 'claude',
          status: 'success',
          durationMs: 5000,
          wordCount: 100,
        }),
      ],
    };
    r.printSummary(manifest, {});
    expect(stdoutOutput).toContain('Run complete: test-run');
  });
});
