import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config, ToolReport } from '../../src/types.js';

// Track dispatch calls to control per-round word counts
let dispatchCallCount = 0;
let wordCountsByRound: number[] = [];
const dispatchPrompts: string[] = [];

vi.mock('../../src/core/dispatcher.js', () => ({
  dispatch: vi
    .fn()
    .mockImplementation(
      async (opts: { outputDir: string; promptContent: string }) => {
        const round = dispatchCallCount++;
        dispatchPrompts.push(opts.promptContent);

        // Simulate report files that later rounds can reference.
        writeFileSync(
          join(opts.outputDir, 'claude.md'),
          `round-${round + 1}`,
          'utf-8',
        );

        const wordCount =
          round < wordCountsByRound.length ? wordCountsByRound[round] : 100;
        const report: ToolReport = {
          toolId: 'claude',
          status: 'success',
          exitCode: 0,
          durationMs: 100,
          wordCount,
          outputFile: '',
          stderrFile: '',
        };
        return [report];
      },
    ),
}));

vi.mock('../../src/core/executor.js', () => ({
  clearSigintExit: vi.fn(),
}));

vi.mock('../../src/core/synthesis.js', () => ({
  synthesize: vi.fn().mockReturnValue('synthesis content'),
}));

const { runLoop } = await import('../../src/core/loop.js');

const testDir = join(tmpdir(), `counselors-loop-test-${Date.now()}`);

function makeConfig(): Config {
  return {
    version: 1,
    defaults: {
      timeout: 10,
      outputDir: testDir,
      readOnly: 'bestEffort',
      maxContextKb: 50,
      maxParallel: 4,
    },
    tools: {
      claude: {
        binary: '/usr/bin/claude',
        readOnly: { level: 'enforced' },
      },
    },
    groups: {},
  };
}

function baseOptions(overrides: Record<string, unknown> = {}) {
  const outputDir = join(testDir, `run-${Date.now()}`);
  mkdirSync(outputDir, { recursive: true });
  return {
    config: makeConfig(),
    toolIds: ['claude'],
    promptContent: 'test prompt',
    promptFilePath: join(outputDir, 'prompt.md'),
    outputDir,
    readOnlyPolicy: 'none' as const,
    cwd: process.cwd(),
    rounds: 3,
    ...overrides,
  };
}

beforeEach(() => {
  mkdirSync(testDir, { recursive: true });
  dispatchCallCount = 0;
  wordCountsByRound = [];
  dispatchPrompts.length = 0;
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('runLoop', () => {
  it('runs the specified number of rounds', async () => {
    const result = await runLoop(baseOptions({ rounds: 2 }));
    expect(result.rounds).toHaveLength(2);
    expect(result.outcome).toBe('completed');
  });

  it('calls onRoundStart and onRoundComplete for each round', async () => {
    const starts: number[] = [];
    const completes: number[] = [];

    await runLoop(
      baseOptions({
        rounds: 2,
        onRoundStart: (r: number) => starts.push(r),
        onRoundComplete: (r: number) => completes.push(r),
      }),
    );

    expect(starts).toEqual([1, 2]);
    expect(completes).toEqual([1, 2]);
  });

  it('sets outcome to aborted when duration limit is reached', async () => {
    // Each dispatch takes ~0ms in mocks, so set durationMs to 0
    // to trigger the duration check on round 2+
    const result = await runLoop(baseOptions({ rounds: 5, durationMs: 0 }));

    // Only round 1 should complete — the duration check fires before round 2
    expect(result.rounds).toHaveLength(1);
    expect(result.outcome).toBe('aborted');
  });

  it('caps prior-round references to control prompt size', async () => {
    await runLoop(baseOptions({ rounds: 30 }));

    const finalPrompt = dispatchPrompts.at(-1) ?? '';
    expect(finalPrompt).toContain(
      'Only the most recent 8 outputs are included',
    );
    const refCount = (finalPrompt.match(/@.*round-\d+[/\\]claude\.md/g) ?? [])
      .length;
    expect(refCount).toBe(8);
  });

  describe('convergence detection', () => {
    it('stops early when word count ratio drops below threshold', async () => {
      // Round 1: 1000 words, Round 2: 200 words → ratio 0.2 < 0.3
      wordCountsByRound = [1000, 200, 100];

      const result = await runLoop(
        baseOptions({ rounds: 5, convergenceThreshold: 0.3 }),
      );

      expect(result.rounds).toHaveLength(2);
      expect(result.outcome).toBe('converged');
    });

    it('calls onConvergence callback with round and ratio', async () => {
      wordCountsByRound = [1000, 100];

      let convergenceRound: number | undefined;
      let convergenceRatio: number | undefined;

      await runLoop(
        baseOptions({
          rounds: 5,
          convergenceThreshold: 0.3,
          onConvergence: (round: number, ratio: number) => {
            convergenceRound = round;
            convergenceRatio = ratio;
          },
        }),
      );

      expect(convergenceRound).toBe(2);
      expect(convergenceRatio).toBe(0.1);
    });

    it('does not converge when ratio stays above threshold', async () => {
      // All rounds have similar word counts → ratio ~1.0
      wordCountsByRound = [100, 100, 100];

      const result = await runLoop(
        baseOptions({ rounds: 3, convergenceThreshold: 0.3 }),
      );

      expect(result.rounds).toHaveLength(3);
      expect(result.outcome).toBe('completed');
    });

    it('respects custom convergence threshold', async () => {
      // Round 1: 100, Round 2: 80 → ratio 0.8
      // With threshold 0.9, this should converge
      wordCountsByRound = [100, 80, 60];

      const result = await runLoop(
        baseOptions({ rounds: 5, convergenceThreshold: 0.9 }),
      );

      expect(result.rounds).toHaveLength(2);
      expect(result.outcome).toBe('converged');
    });

    it('skips convergence check on first round', async () => {
      // Even with very low word count on round 1, should not converge
      wordCountsByRound = [1, 1000, 900];

      const result = await runLoop(
        baseOptions({ rounds: 3, convergenceThreshold: 0.3 }),
      );

      // Should run all 3 rounds since round 2→3 ratio is 0.9
      expect(result.rounds).toHaveLength(3);
    });

    it('does not divide by zero when previous round has zero words', async () => {
      wordCountsByRound = [0, 100, 50];

      const result = await runLoop(
        baseOptions({ rounds: 3, convergenceThreshold: 0.3 }),
      );

      // Should run all 3 rounds — the 0→100 comparison is skipped (prevWords === 0)
      // and 100→50 ratio is 0.5 which is above 0.3
      expect(result.rounds).toHaveLength(3);
      expect(result.outcome).toBe('completed');
    });
  });

  describe('round delay', () => {
    it('delays between rounds but not after the last', async () => {
      const startTime = Date.now();
      const result = await runLoop(
        baseOptions({ rounds: 3, roundDelayMs: 50 }),
      );
      const elapsed = Date.now() - startTime;

      expect(result.rounds).toHaveLength(3);
      expect(result.outcome).toBe('completed');
      // 2 inter-round delays × 50ms; upper bound proves no extra delay after last round
      expect(elapsed).toBeGreaterThanOrEqual(80);
      expect(elapsed).toBeLessThan(200);
    });

    it('bounds delay by remaining duration', async () => {
      const startTime = Date.now();
      // Mock dispatch is ~instant. After round 1, remaining ≈ 100ms.
      // Delay = min(5000, ~100) ≈ 100ms. Then duration expires before round 2.
      const result = await runLoop(
        baseOptions({ rounds: 5, durationMs: 100, roundDelayMs: 5000 }),
      );
      const elapsed = Date.now() - startTime;

      expect(result.rounds).toHaveLength(1);
      expect(result.outcome).toBe('aborted');
      // Bounded to ~100ms, not 5s
      expect(elapsed).toBeLessThan(300);
    });
  });
});
