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
  vi.clearAllTimers();
  vi.useRealTimers();
});

async function createReporter() {
  const { TerminalReporter } = await import(
    '../../src/ui/terminal-reporter.js'
  );
  return new TerminalReporter();
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

describe('TerminalReporter phases', () => {
  it('shows spinner for discovery phase', async () => {
    vi.useFakeTimers();
    const r = await createReporter();
    r.discoveryStarted('claude');
    expect(stderrOutput).toContain('Discovery phase: claude');
    r.discoveryCompleted('claude');
    expect(stderrOutput).toContain('Discovery complete');
  });

  it('shows spinner for prompt-writing phase', async () => {
    vi.useFakeTimers();
    const r = await createReporter();
    r.promptWritingStarted('claude');
    expect(stderrOutput).toContain('Prompt-writing phase: claude');
    r.promptWritingCompleted('claude');
    expect(stderrOutput).toContain('Prompt-writing complete');
  });

  it('updates spinner text with PID on phasePidReported', async () => {
    vi.useFakeTimers();
    const r = await createReporter();
    r.discoveryStarted('codex');
    stderrOutput = '';
    r.phasePidReported('codex', 82795);
    expect(stderrOutput).toContain('Discovery phase: codex (PID 82795)');
    r.discoveryCompleted('codex');
  });
});

describe('TerminalReporter execution', () => {
  it('renders output dir on executionStarted', async () => {
    vi.useFakeTimers();
    const r = await createReporter();
    r.executionStarted('/tmp/output', ['claude']);
    expect(stderrOutput).toContain('Output: /tmp/output');
    r.executionFinished();
  });

  it('passes through paths as-is', async () => {
    vi.useFakeTimers();
    const r = await createReporter();
    r.executionStarted('/abs/agents/counselors/test', ['claude']);
    expect(stderrOutput).toContain('Output: /abs/agents/counselors/test');
    r.executionFinished();
  });

  it('renders pending tools', async () => {
    vi.useFakeTimers();
    const r = await createReporter();
    r.executionStarted('/tmp/output', ['claude']);
    expect(stderrOutput).toContain('pending');
    r.executionFinished();
  });

  it('shows PID in running tool line', async () => {
    vi.useFakeTimers();
    const r = await createReporter();
    r.executionStarted('/tmp/output', ['claude']);
    r.toolStarted('claude', 42);
    vi.advanceTimersByTime(200);
    expect(stderrOutput).toContain('PID 42');
    expect(stderrOutput).toContain('running');
    r.executionFinished();
  });

  it('renders stderr file path for failed tools', async () => {
    vi.useFakeTimers();
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
    // Force render
    vi.advanceTimersByTime(200);
    expect(stderrOutput).toContain('see /tmp/output/gemini.stderr');
    r.executionFinished();
  });

  it('renders timeout icon for timed-out tools', async () => {
    vi.useFakeTimers();
    const r = await createReporter();
    r.executionStarted('/tmp/output', ['slow']);
    r.toolStarted('slow');
    r.toolCompleted('slow', makeReport({ toolId: 'slow', status: 'timeout' }));
    vi.advanceTimersByTime(200);
    expect(stderrOutput).toContain('done');
    r.executionFinished();
  });

  it('ignores unknown tool IDs without throwing', async () => {
    vi.useFakeTimers();
    const r = await createReporter();
    r.executionStarted('/tmp/output', ['claude']);
    // Should not throw
    r.toolStarted('nonexistent');
    r.toolCompleted('nonexistent', makeReport());
    r.executionFinished();
  });

  it('shows info line only after a tool starts', async () => {
    vi.useFakeTimers();
    const r = await createReporter();
    r.executionStarted('/tmp/output', ['claude']);
    // Before any tool starts — no info line
    expect(stderrOutput).not.toContain('This may take more than 10 minutes');

    r.toolStarted('claude');
    vi.advanceTimersByTime(200);
    expect(stderrOutput).toContain('This may take more than 10 minutes');
    expect(stderrOutput).toContain(`PID: ${process.pid}`);
    r.executionFinished();
  });

  it('renders multiple tools', async () => {
    vi.useFakeTimers();
    const r = await createReporter();
    r.executionStarted('/tmp/output', ['claude', 'codex']);
    r.toolStarted('claude', 111);
    r.toolStarted('codex', 222);
    vi.advanceTimersByTime(200);
    expect(stderrOutput).toContain('PID 111');
    expect(stderrOutput).toContain('PID 222');
    r.toolCompleted('claude', makeReport({ toolId: 'claude' }));
    r.toolCompleted('codex', makeReport({ toolId: 'codex' }));
    r.executionFinished();
    expect(stderrOutput).toContain('done');
  });

  it('stops render timer on executionFinished', async () => {
    vi.useFakeTimers();
    const r = await createReporter();
    r.executionStarted('/tmp/output', ['claude']);
    r.executionFinished();
    stderrOutput = '';

    // Advance time — no more renders should happen
    vi.advanceTimersByTime(1000);
    // Only ANSI cursor movements from the final render, no new tool table content
    expect(stderrOutput).toBe('');
  });
});

describe('TerminalReporter rounds', () => {
  it('renders round header in tool table', async () => {
    vi.useFakeTimers();
    const r = await createReporter();
    r.executionStarted('/tmp/output', ['claude']);
    r.roundStarted(1, 3);
    // Force a render tick
    vi.advanceTimersByTime(200);
    expect(stderrOutput).toContain('Round 1/3');
    r.executionFinished();
  });

  it('resets tool states on roundStarted', async () => {
    vi.useFakeTimers();
    const r = await createReporter();
    r.executionStarted('/tmp/output', ['claude']);
    r.toolStarted('claude');
    r.toolCompleted('claude', makeReport({ toolId: 'claude' }));

    // Round 2 resets
    r.roundStarted(2, 3);
    vi.advanceTimersByTime(200);
    // After reset, tool should be back to pending
    expect(stderrOutput).toContain('pending');
    r.executionFinished();
  });

  it('prints convergence message', async () => {
    vi.useFakeTimers();
    const r = await createReporter();
    r.executionStarted('/tmp/output', ['claude']);
    r.convergenceDetected(2, 0.15, 0.3);
    expect(stderrOutput).toContain('Convergence');
    expect(stderrOutput).toContain('round 2');
    r.executionFinished();
  });

  it('shows elapsed time and Ctrl+C hint between rounds', async () => {
    vi.useFakeTimers();
    const r = await createReporter();
    r.executionStarted('/tmp/output', ['claude']);
    r.roundStarted(1, 3);
    vi.advanceTimersByTime(90_000);
    r.roundStarted(2, 3);
    expect(stderrOutput).toContain('1m 30s elapsed');
    expect(stderrOutput).toContain('Ctrl+C to stop');
    r.executionFinished();
  });

  it('shows remaining time when durationMs is set', async () => {
    vi.useFakeTimers();
    const r = await createReporter();
    r.executionStarted('/tmp/output', ['claude'], { durationMs: 300_000 });
    r.roundStarted(1, 3);
    vi.advanceTimersByTime(120_000);
    r.roundStarted(2, 3);
    expect(stderrOutput).toContain('2m 0s elapsed');
    expect(stderrOutput).toContain('~3m 0s remaining');
    r.executionFinished();
  });
});

describe('TerminalReporter round delay', () => {
  it('renders countdown line during delay', async () => {
    vi.useFakeTimers();
    const r = await createReporter();
    r.executionStarted('/tmp/output', ['claude']);
    r.roundStarted(1, 3);
    r.toolStarted('claude');
    r.toolCompleted('claude', makeReport({ toolId: 'claude' }));

    r.roundDelayStarted(2, 30_000);
    vi.advanceTimersByTime(200);
    expect(stderrOutput).toContain('Round 2/3: starting after');
    expect(stderrOutput).toContain('Ctrl+C to stop');
    r.roundDelayEnded();
    r.executionFinished();
  });

  it('clears countdown line after roundDelayEnded', async () => {
    vi.useFakeTimers();
    const r = await createReporter();
    r.executionStarted('/tmp/output', ['claude']);
    r.roundStarted(1, 3);

    r.roundDelayStarted(2, 10_000);
    vi.advanceTimersByTime(200);
    expect(stderrOutput).toContain('Round 2/3: starting after');

    r.roundDelayEnded();
    stderrOutput = '';
    vi.advanceTimersByTime(200);
    expect(stderrOutput).not.toContain('starting after');
    r.executionFinished();
  });

  it('uses Math.ceil so countdown never shows 0s while waiting', async () => {
    vi.useFakeTimers();
    const r = await createReporter();
    r.executionStarted('/tmp/output', ['claude']);
    r.roundStarted(1, null);

    r.roundDelayStarted(2, 1500);
    // At t=0, 1500ms remaining → ceil → 2s
    expect(stderrOutput).not.toContain('0s');

    vi.advanceTimersByTime(800);
    // At t=800, 700ms remaining → ceil → 1s
    stderrOutput = '';
    vi.advanceTimersByTime(200);
    expect(stderrOutput).toContain('1s');
    expect(stderrOutput).not.toContain('0s');
    r.roundDelayEnded();
    r.executionFinished();
  });

  it('renders round label without total when totalRounds is null', async () => {
    vi.useFakeTimers();
    const r = await createReporter();
    r.executionStarted('/tmp/output', ['claude']);
    r.roundStarted(1, null);

    r.roundDelayStarted(2, 5000);
    vi.advanceTimersByTime(200);
    expect(stderrOutput).toContain('Round 2: starting after');
    expect(stderrOutput).not.toContain('Round 2/');
    r.roundDelayEnded();
    r.executionFinished();
  });
});

describe('TerminalReporter printSummary', () => {
  it('writes to stdout', async () => {
    const r = await createReporter();
    const manifest = {
      timestamp: '2024-01-01T00:00:00Z',
      slug: 'test-run',
      prompt: 'test',
      promptSource: 'inline' as const,
      readOnlyPolicy: 'none' as const,
      tools: [makeReport({ toolId: 'claude' })],
    };
    r.printSummary(manifest, {});
    expect(stdoutOutput).toContain('Run complete: test-run');
    // Nothing to stderr for summary
  });

  it('writes JSON when json option is set', async () => {
    const r = await createReporter();
    const manifest = {
      timestamp: '',
      slug: 'test',
      prompt: 'test',
      promptSource: 'inline' as const,
      readOnlyPolicy: 'none' as const,
      tools: [],
    };
    r.printSummary(manifest, { json: true });
    expect(stdoutOutput).toContain('"slug": "test"');
  });
});
