import { mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Config, ReadOnlyLevel, RoundManifest } from '../types.js';
import type { ProgressEvent } from './dispatcher.js';
import { dispatch } from './dispatcher.js';
import { clearSigintExit } from './executor.js';
import { safeWriteFile } from './fs-utils.js';
import { synthesize } from './synthesis.js';

export interface LoopOptions {
  config: Config;
  toolIds: string[];
  promptContent: string;
  promptFilePath: string;
  outputDir: string;
  readOnlyPolicy: ReadOnlyLevel;
  cwd: string;
  rounds: number;
  durationMs?: number;
  /** Word count ratio threshold for early stop (default: 0.3). */
  convergenceThreshold?: number;
  /** Delay between rounds in milliseconds (default: 0). */
  roundDelayMs?: number;
  onRoundStart?: (round: number) => void;
  onRoundComplete?: (round: number, manifest: RoundManifest) => void;
  onConvergence?: (round: number, ratio: number) => void;
  onRoundDelay?: (nextRound: number, delayMs: number) => void;
  onRoundDelayEnd?: () => void;
  onProgress?: (event: ProgressEvent) => void;
}

export interface LoopResult {
  rounds: RoundManifest[];
  outcome: 'completed' | 'aborted' | 'converged';
}

const MAX_PRIOR_REPORT_REFS = 8;

/** Sum word counts across all tool reports in a round. */
function totalWordCount(round: RoundManifest): number {
  return round.tools.reduce((sum, r) => sum + r.wordCount, 0);
}

/**
 * Run multiple dispatch rounds, feeding prior round outputs into subsequent rounds.
 */
export async function runLoop(options: LoopOptions): Promise<LoopResult> {
  const {
    config,
    toolIds,
    promptContent,
    outputDir,
    readOnlyPolicy,
    cwd,
    rounds: maxRounds,
    durationMs,
    convergenceThreshold = 0.3,
    roundDelayMs = 0,
    onRoundStart,
    onRoundComplete,
    onConvergence,
    onRoundDelay,
    onRoundDelayEnd,
    onProgress,
  } = options;

  const startTime = Date.now();
  const completedRounds: RoundManifest[] = [];
  let outcome: LoopResult['outcome'] = 'completed';
  let aborted = false;

  let delayAbort: AbortController | null = null;

  // SIGINT: let the current round finish, then stop the loop.
  // Second SIGINT falls through to the executor's handler which force-exits.
  let sigintCount = 0;
  const sigintHandler = () => {
    sigintCount++;
    if (sigintCount === 1) {
      aborted = true;
      outcome = 'aborted';
      // Suppress the executor's auto-exit so we can write manifests
      clearSigintExit();
      delayAbort?.abort();
    }
    // Second SIGINT: re-register original behavior (process will exit via executor handler)
  };
  process.on('SIGINT', sigintHandler);

  try {
    for (let round = 1; round <= maxRounds; round++) {
      // Check stop conditions before starting a new round
      if (aborted) break;
      if (
        durationMs != null &&
        round > 1 &&
        Date.now() - startTime >= durationMs
      ) {
        outcome = 'aborted';
        break;
      }

      onRoundStart?.(round);

      // Output layout: {outputDir}/round-{N}/{tool-id}.md, round-notes.md, prompt.md
      const roundDir = join(outputDir, `round-${round}`);
      mkdirSync(roundDir, { recursive: true });

      // Build round prompt: augment with @file references for round 2+
      let roundPrompt: string;
      const priorRoundReportPaths = collectPriorOutputPaths(
        outputDir,
        completedRounds,
      );

      if (round > 1 && priorRoundReportPaths.length > 0) {
        roundPrompt = augmentPromptWithPriorOutputs(
          promptContent,
          priorRoundReportPaths,
        );
      } else {
        roundPrompt = promptContent;
      }

      // Write round prompt
      const roundPromptFile = resolve(roundDir, 'prompt.md');
      safeWriteFile(roundPromptFile, roundPrompt);

      // Dispatch this round
      const reports = await dispatch({
        config,
        toolIds,
        promptFilePath: roundPromptFile,
        promptContent: roundPrompt,
        outputDir: roundDir,
        readOnlyPolicy,
        cwd,
        onProgress,
      });

      // Build round manifest
      const roundManifest: RoundManifest = {
        round,
        timestamp: new Date().toISOString(),
        tools: reports,
      };

      // Synthesize round results
      const roundSynthesis = synthesize(
        {
          timestamp: roundManifest.timestamp,
          slug: `round-${round}`,
          prompt: roundPrompt.slice(0, 200),
          promptSource: 'inline',
          readOnlyPolicy,
          tools: reports,
        },
        roundDir,
      );
      safeWriteFile(resolve(roundDir, 'round-notes.md'), roundSynthesis);

      completedRounds.push(roundManifest);
      onRoundComplete?.(round, roundManifest);

      // Convergence detection: compare word count of this round vs previous
      if (completedRounds.length >= 2) {
        const prevWords = totalWordCount(
          completedRounds[completedRounds.length - 2],
        );
        const curWords = totalWordCount(roundManifest);
        if (prevWords > 0) {
          const ratio = curWords / prevWords;
          if (ratio < convergenceThreshold) {
            outcome = 'converged';
            onConvergence?.(round, ratio);
            break;
          }
        }
      }

      if (roundDelayMs > 0 && round < maxRounds && !aborted) {
        const remaining =
          durationMs != null
            ? durationMs - (Date.now() - startTime)
            : Infinity;
        if (remaining <= 0) {
          outcome = 'aborted';
          break;
        }

        const actualDelay = Math.min(roundDelayMs, remaining);
        onRoundDelay?.(round + 1, actualDelay);
        delayAbort = new AbortController();
        await delay(actualDelay, undefined, { signal: delayAbort.signal }).catch(
          () => {},
        );
        delayAbort = null;
        onRoundDelayEnd?.();
      }
    }
  } finally {
    process.removeListener('SIGINT', sigintHandler);
  }

  return { rounds: completedRounds, outcome };
}

/**
 * Collect all .md output files from prior rounds (excluding round notes and prompt files).
 */
function collectPriorOutputPaths(
  outputDir: string,
  rounds: RoundManifest[],
): string[] {
  const paths: string[] = [];
  for (const round of rounds) {
    const roundDir = join(outputDir, `round-${round.round}`);
    try {
      for (const file of readdirSync(roundDir)) {
        if (
          file.endsWith('.md') &&
          file !== 'prompt.md' &&
          file !== 'round-notes.md'
        ) {
          paths.push(join(roundDir, file));
        }
      }
    } catch {
      // round dir may not exist if aborted early
    }
  }
  return paths;
}

/**
 * Default prompt augmentation: append @file references to prior round outputs.
 */
function augmentPromptWithPriorOutputs(
  basePrompt: string,
  priorRoundReportPaths: string[],
): string {
  const cappedPaths = priorRoundReportPaths.slice(-MAX_PRIOR_REPORT_REFS);
  const omittedCount = priorRoundReportPaths.length - cappedPaths.length;
  const refs = cappedPaths.map((p) => `@${p}`).join('\n');
  const capNote =
    omittedCount > 0
      ? `\nOnly the most recent ${MAX_PRIOR_REPORT_REFS} outputs are included to control prompt size (${omittedCount} older output(s) omitted).\n`
      : '';
  return `${basePrompt}

## Prior Round Outputs

The following files contain outputs from previous rounds. Use them to improve quality, not just avoid duplicates.

${capNote}

Round instructions:
- Do not repeat the same finding unless you add meaningful new evidence.
- Challenge prior findings: try to invalidate, narrow, or refine high-impact claims.
- Treat prior findings as leads: follow adjacent code paths, shared utilities, and similar patterns.
- For any finding that overlaps prior rounds, clearly label status as confirmed, refined, invalidated, or duplicate and explain what is new.

${refs}
`;
}
