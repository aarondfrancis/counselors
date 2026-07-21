import { join } from 'node:path';
import pLimit from 'p-limit';
import { resolveAdapter } from '../adapters/index.js';
import { sanitizeId } from '../constants.js';
import type {
  Config,
  ReadOnlyLevel,
  RunRequest,
  ToolReport,
} from '../types.js';
import { debug, warn } from '../ui/logger.js';
import {
  captureAmpUsage,
  computeAmpCostFromSnapshots,
  execute,
} from './executor.js';
import { safeWriteFile } from './fs-utils.js';

export interface ProgressEvent {
  toolId: string;
  event: 'started' | 'completed';
  report?: ToolReport;
  pid?: number;
}

export interface DispatchOptions {
  config: Config;
  toolIds: string[];
  promptFilePath: string;
  promptContent: string;
  outputDir: string;
  readOnlyPolicy: ReadOnlyLevel;
  cwd: string;
  onProgress?: (event: ProgressEvent) => void;
}

/**
 * Dispatch prompts to all selected tools in parallel with bounded concurrency.
 */
export async function dispatch(
  options: DispatchOptions,
): Promise<ToolReport[]> {
  const {
    config,
    toolIds,
    promptFilePath,
    promptContent,
    outputDir,
    readOnlyPolicy,
    cwd,
    onProgress,
  } = options;
  const limit = pLimit(config.defaults.maxParallel);

  // Filter tools based on read-only policy
  const eligibleTools = toolIds.filter((id) => {
    const toolConfig = config.tools[id];
    if (!toolConfig) {
      warn(`Tool "${id}" not configured, skipping.`);
      return false;
    }

    if (readOnlyPolicy === 'enforced') {
      const adapter = resolveAdapter(id, toolConfig);
      const effectiveLevel = adapter.getEffectiveReadOnlyLevel
        ? adapter.getEffectiveReadOnlyLevel(toolConfig)
        : adapter.readOnly.level;
      if (effectiveLevel !== 'enforced') {
        warn(
          `Skipping "${id}" — read-only level is "${effectiveLevel}", policy requires "enforced".`,
        );
        return false;
      }
    }

    return true;
  });

  if (eligibleTools.length === 0) {
    throw new Error('No eligible tools after read-only policy filtering.');
  }

  const tasks = eligibleTools.map((id) =>
    limit(async (): Promise<ToolReport> => {
      const toolConfig = config.tools[id];
      const adapter = resolveAdapter(id, toolConfig);

      const toolTimeout = toolConfig.timeout ?? config.defaults.timeout;
      const toolTimeoutMs = toolTimeout * 1000;

      const req: RunRequest = {
        prompt: promptContent,
        promptFilePath,
        toolId: id,
        outputDir,
        readOnlyPolicy,
        timeout: toolTimeout,
        cwd,
        binary: toolConfig.binary,
        extraFlags: toolConfig.extraFlags,
      };

      const invocation = adapter.buildInvocation(req);

      // Amp cost tracking: capture usage before
      const isAmp = (toolConfig.adapter ?? id) === 'amp';
      const usageBefore = isAmp ? await captureAmpUsage() : null;

      debug(`Dispatching ${id}`);
      const result = await execute(invocation, toolTimeoutMs, (pid) => {
        onProgress?.({ toolId: id, event: 'started', pid });
      });

      // Amp cost tracking: capture usage after
      const usageAfter = isAmp ? await captureAmpUsage() : null;
      const cost =
        isAmp && usageBefore && usageAfter
          ? computeAmpCostFromSnapshots(usageBefore, usageAfter)
          : undefined;

      // Write output files
      const safeId = sanitizeId(id);
      const outputFile = join(outputDir, `${safeId}.md`);
      const stderrFile = join(outputDir, `${safeId}.stderr`);

      safeWriteFile(outputFile, result.stdout);
      safeWriteFile(stderrFile, result.stderr);

      if (cost) {
        const statsFile = join(outputDir, `${safeId}.stats.json`);
        safeWriteFile(statsFile, JSON.stringify({ cost }, null, 2));
      }

      const parsed = adapter.parseResult?.(result) ?? {};

      const report: ToolReport = {
        toolId: id,
        // Defaults (overridden by adapter's parseResult)
        status: 'error',
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        wordCount: 0,
        // Adapter-authoritative fields
        ...parsed,
        // Dispatcher-only fields (never overridden by adapter)
        outputFile,
        stderrFile,
        cost: cost ?? undefined,
        // An adapter's parseResult may know a failure exitCode alone can't
        // express (e.g. a tool that exits 0 on a permission denial) —
        // let it supply the message; only fall back to stderr otherwise.
        error:
          parsed.error ??
          (result.exitCode !== 0 ? result.stderr.slice(0, 500) : undefined),
      };

      onProgress?.({ toolId: id, event: 'completed', report });

      return report;
    }),
  );

  const results = await Promise.allSettled(tasks);

  return results.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    return {
      toolId: eligibleTools[i],
      status: 'error' as const,
      exitCode: 1,
      durationMs: 0,
      wordCount: 0,
      outputFile: '',
      stderrFile: '',
      error: r.reason?.message ?? 'Unknown error',
    };
  });
}
