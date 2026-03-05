import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import { getExecutionBoilerplate } from '../core/boilerplate.js';
import { parseDurationMs } from '../core/cleanup.js';
import { safeWriteFile } from '../core/fs-utils.js';
import { runLoop } from '../core/loop.js';
import { generateSlug } from '../core/prompt-builder.js';
import { writePrompt } from '../core/prompt-writer.js';
import { runRepoDiscovery } from '../core/repo-discovery.js';
import { synthesizeFinal } from '../core/synthesis.js';
import { getPresetNames, resolvePreset } from '../presets/index.js';
import type { PresetDefinition } from '../presets/types.js';
import type { RunManifest } from '../types.js';
import { error, info, warn } from '../ui/logger.js';
import { formatDryRun } from '../ui/output.js';
import { createReporter } from '../ui/reporter.js';
import {
  buildDryRunInvocations,
  createOutputDir,
  getPromptLabel,
  resolvePrompt,
  resolveReadOnlyPolicy,
  resolveTools,
} from './_run-shared.js';

const INLINE_PROMPT_ENHANCEMENT_DESCRIPTION = `You are preparing a multi-round code review prompt from a raw user request (no preset selected). Preserve the user's intent and success criteria, then expand it into a concrete execution prompt grounded in the discovered repository context. Require evidence-backed findings with file/function references, clear risk framing, and concrete fix suggestions.`;

function withExecutionBoilerplate(promptContent: string): string {
  const content = promptContent.trimEnd();
  const boilerplate = getExecutionBoilerplate().trim();
  if (content.includes(boilerplate)) return content;
  return content.length > 0 ? `${content}\n\n${boilerplate}` : boilerplate;
}

export function registerLoopCommand(program: Command): void {
  const loopCmd = program
    .command('loop [prompt]')
    .description(
      'Multi-round dispatch — tools (agents) iterate, seeing prior outputs each round',
    )
    .option(
      '-f, --file <path>',
      'Use a pre-built prompt file (skip discovery/prompt-writing enhancement)',
    )
    .option('-t, --tools <tools>', 'Comma-separated list of tools to use')
    .option(
      '-g, --group <groups>',
      'Comma-separated group name(s) to run (expands to tool IDs)',
    )
    .option(
      '--context <paths>',
      'Gather context from paths (comma-separated, or "." for git diff)',
    )
    .option('--read-only <level>', 'Read-only policy: strict, best-effort, off')
    .option('--rounds <N>', 'Number of dispatch rounds', '3')
    .option('--duration <time>', 'Max total duration (e.g. "30m", "1h")')
    .option('--preset <name>', 'Use a built-in preset (e.g. "bughunt")')
    .option('--list-presets', 'List built-in presets and exit')
    .option(
      '--discovery-tool <id>',
      'Tool for discovery and prompt-writing phases (default: first tool)',
    )
    .option(
      '--no-inline-enhancement',
      'Skip discovery/prompt-writing for non-preset inline prompts',
    )
    .option(
      '--convergence-threshold <ratio>',
      'Word count ratio for early stop',
      '0.3',
    )
    .option('--round-delay <time>', 'Delay between rounds (e.g. "30s", "5m")')
    .option('--dry-run', 'Show what would be dispatched without running')
    .option('--json', 'Output manifest as JSON')
    .option('-o, --output-dir <dir>', 'Base output directory');

  loopCmd.action(
    async (
      promptArg: string | undefined,
      opts: {
        file?: string;
        tools?: string;
        group?: string;
        context?: string;
        readOnly?: string;
        rounds?: string;
        duration?: string;
        preset?: string;
        listPresets?: boolean;
        discoveryTool?: string;
        inlineEnhancement?: boolean;
        convergenceThreshold?: string;
        roundDelay?: string;
        dryRun?: boolean;
        json?: boolean;
        outputDir?: string;
      },
    ) => {
      const cwd = process.cwd();

      if (opts.listPresets) {
        const names = getPresetNames();
        if (names.length === 0) {
          info('No built-in presets found.');
          return;
        }

        info('Built-in presets:');
        for (const name of names) {
          const preset = resolvePreset(name);
          const firstLine = preset.description.split('\n')[0]?.trim() ?? '';
          const rounds = preset.defaultRounds ?? 3;
          info(`- ${name} (rounds: ${rounds}): ${firstLine}`);
        }
        return;
      }

      // Resolve tools
      const resolved = await resolveTools(opts, cwd);
      if (!resolved) return;
      const { toolIds, config } = resolved;

      // Resolve read-only policy
      let readOnlyPolicy = resolveReadOnlyPolicy(opts.readOnly, config);
      if (!readOnlyPolicy) return;

      // Parse rounds and duration
      const roundsExplicit = loopCmd.getOptionValueSource('rounds') === 'cli';
      let rounds = Number.parseInt(opts.rounds ?? '3', 10);
      if (Number.isNaN(rounds) || rounds < 1) {
        error('--rounds must be a positive integer.');
        process.exitCode = 1;
        return;
      }

      let durationMs: number | undefined;
      if (opts.duration) {
        try {
          durationMs = parseDurationMs(opts.duration);
        } catch (e) {
          error(
            e instanceof Error
              ? e.message
              : `Invalid --duration value "${opts.duration}".`,
          );
          process.exitCode = 1;
          return;
        }
        // If duration is set but rounds is default, allow unlimited rounds
        if (!roundsExplicit) rounds = Number.MAX_SAFE_INTEGER;
      }

      // Parse convergence threshold
      const convergenceThreshold = Number.parseFloat(
        opts.convergenceThreshold ?? '0.3',
      );
      if (
        Number.isNaN(convergenceThreshold) ||
        convergenceThreshold < 0 ||
        convergenceThreshold > 1
      ) {
        error('--convergence-threshold must be a number between 0 and 1.');
        process.exitCode = 1;
        return;
      }

      // Parse round delay
      let roundDelayMs: number | undefined;
      if (opts.roundDelay) {
        try {
          roundDelayMs = parseDurationMs(opts.roundDelay);
          // Warn about bare numeric values (interpreted as days)
          if (/^\d+(\.\d+)?$/.test(opts.roundDelay)) {
            warn(
              `--round-delay ${opts.roundDelay} interpreted as ${opts.roundDelay} days. Did you mean ${opts.roundDelay}s (seconds) or ${opts.roundDelay}m (minutes)?`,
            );
          }
        } catch (e) {
          error(
            e instanceof Error
              ? e.message
              : `Invalid --round-delay value "${opts.roundDelay}".`,
          );
          process.exitCode = 1;
          return;
        }
      }

      // Resolve preset
      let preset: PresetDefinition | undefined;

      if (opts.preset) {
        try {
          preset = resolvePreset(opts.preset);
        } catch (e) {
          error(
            e instanceof Error ? e.message : `Unknown preset "${opts.preset}".`,
          );
          process.exitCode = 1;
          return;
        }

        // Apply preset defaults (only if not explicitly overridden)
        if (!roundsExplicit && !durationMs && preset.defaultRounds) {
          rounds = preset.defaultRounds;
        }
        if (!opts.readOnly && preset.defaultReadOnly) {
          readOnlyPolicy = preset.defaultReadOnly;
        }
      }

      // Resolve prompt
      let promptContent: string;
      let promptSource: 'inline' | 'file' | 'stdin';
      let slug: string;

      const reporter = createReporter({ dryRun: opts.dryRun });
      const getDiscoveryToolId = (): string | null => {
        const discoveryToolId = opts.discoveryTool ?? toolIds[0];
        if (!config.tools[discoveryToolId]) {
          error(`Discovery tool "${discoveryToolId}" not configured.`);
          process.exitCode = 1;
          return null;
        }
        return discoveryToolId;
      };

      if (preset) {
        // Preset mode: prompt arg is the user's target/focus
        if (!promptArg) {
          error(
            `Preset "${preset.name}" requires a prompt argument describing what to focus on.`,
          );
          process.exitCode = 1;
          return;
        }

        // Discovery tool: first tool or explicit --discovery-tool
        const discoveryToolId = getDiscoveryToolId();
        if (!discoveryToolId) return;

        slug = generateSlug(preset.name);
        promptSource = 'inline';

        if (opts.dryRun) {
          // Dry run: show what would happen without running prep phases
          promptContent = `[Generated by ${preset.name} preset after discovery + prompt-writing phases]`;
        } else {
          // Phase 1: Discovery
          reporter.discoveryStarted(discoveryToolId);
          let repoContext: string;
          try {
            const discovery = await runRepoDiscovery({
              config,
              toolId: discoveryToolId,
              cwd,
              target: promptArg,
              onProgress: (event) => {
                if (event.event === 'started')
                  reporter.phasePidReported(event.toolId, event.pid!);
              },
            });
            repoContext = discovery.repoContext;
          } catch (e) {
            error(
              `Discovery failed: ${e instanceof Error ? e.message : String(e)}`,
            );
            process.exitCode = 1;
            return;
          }
          reporter.discoveryCompleted(discoveryToolId);

          // Phase 2: Prompt Writing
          reporter.promptWritingStarted(discoveryToolId);
          let generatedPrompt: string;
          try {
            const result = await writePrompt({
              config,
              toolId: discoveryToolId,
              cwd,
              userInput: promptArg,
              presetDescription: preset.description,
              repoContext,
              onProgress: (event) => {
                if (event.event === 'started')
                  reporter.phasePidReported(event.toolId, event.pid!);
              },
            });
            generatedPrompt = result.generatedPrompt;
          } catch (e) {
            error(
              `Prompt writing failed: ${e instanceof Error ? e.message : String(e)}`,
            );
            process.exitCode = 1;
            return;
          }
          reporter.promptWritingCompleted(discoveryToolId);

          promptContent = generatedPrompt;
        }
      } else {
        const prompt = await resolvePrompt(
          promptArg,
          {
            file: opts.file,
            context: opts.context,
            enrichStdinPrompt: false,
          },
          cwd,
          config,
        );
        if (!prompt) return;
        promptContent = prompt.promptContent;
        promptSource = prompt.promptSource;
        slug = prompt.slug;

        const shouldEnhanceInline =
          promptSource === 'inline' && opts.inlineEnhancement !== false;
        if (shouldEnhanceInline) {
          const discoveryToolId = getDiscoveryToolId();
          if (!discoveryToolId) return;

          if (opts.dryRun) {
            promptContent =
              '[Generated from inline prompt after discovery + prompt-writing phases]';
          } else {
            reporter.discoveryStarted(discoveryToolId);
            let repoContext: string;
            try {
              const discovery = await runRepoDiscovery({
                config,
                toolId: discoveryToolId,
                cwd,
                target: promptArg,
                onProgress: (event) => {
                  if (event.event === 'started')
                    reporter.phasePidReported(event.toolId, event.pid!);
                },
              });
              repoContext = discovery.repoContext;
            } catch (e) {
              error(
                `Discovery failed: ${e instanceof Error ? e.message : String(e)}`,
              );
              process.exitCode = 1;
              return;
            }
            reporter.discoveryCompleted(discoveryToolId);

            reporter.promptWritingStarted(discoveryToolId);
            let generatedPrompt: string;
            try {
              const result = await writePrompt({
                config,
                toolId: discoveryToolId,
                cwd,
                userInput: promptArg ?? promptContent,
                presetDescription: INLINE_PROMPT_ENHANCEMENT_DESCRIPTION,
                repoContext,
                onProgress: (event) => {
                  if (event.event === 'started')
                    reporter.phasePidReported(event.toolId, event.pid!);
                },
              });
              generatedPrompt = result.generatedPrompt;
            } catch (e) {
              error(
                `Prompt writing failed: ${e instanceof Error ? e.message : String(e)}`,
              );
              process.exitCode = 1;
              return;
            }
            reporter.promptWritingCompleted(discoveryToolId);
            promptContent = generatedPrompt;
          }
        }
      }

      // Always include execution boilerplate regardless of prompt source.
      promptContent = withExecutionBoilerplate(promptContent);

      if (!slug) slug = generateSlug('loop');

      // Dry run — no filesystem side effects
      if (opts.dryRun) {
        const baseDir = opts.outputDir || config.defaults.outputDir;
        const dryOutputDir = join(baseDir, slug);
        const invocations = buildDryRunInvocations(
          config,
          toolIds,
          promptContent,
          dryOutputDir,
          readOnlyPolicy,
          cwd,
        );
        info(formatDryRun(invocations));
        const roundCount =
          rounds === Number.MAX_SAFE_INTEGER ? 'unlimited' : String(rounds);
        const durStr = durationMs ? `, max duration: ${opts.duration}` : '';
        info(`  Rounds: ${roundCount}${durStr}`);
        if (preset) {
          info(`  Preset: ${preset.name}`);
        }
        info(`  Convergence threshold: ${convergenceThreshold}`);
        if (roundDelayMs) {
          info(`  Round delay: ${opts.roundDelay}`);
        }
        return;
      }

      // Create output directory
      const { outputDir, promptFilePath } = createOutputDir(
        opts,
        slug,
        promptContent,
        cwd,
        config,
      );

      const promptLabel = getPromptLabel(promptArg, opts.file);

      // Run multi-round loop
      const runStart = Date.now();
      const totalRoundsLabel =
        rounds === Number.MAX_SAFE_INTEGER ? null : rounds;
      reporter.executionStarted(outputDir, toolIds, { durationMs });

      try {
        const loopResult = await runLoop({
          config,
          toolIds,
          promptContent,
          promptFilePath,
          outputDir,
          readOnlyPolicy,
          cwd,
          rounds,
          durationMs,
          convergenceThreshold,
          roundDelayMs,
          onRoundStart: (round) => {
            reporter.roundStarted(round, totalRoundsLabel);
          },
          onProgress: (event) => {
            if (event.event === 'started')
              reporter.toolStarted(event.toolId, event.pid);
            if (event.event === 'completed')
              reporter.toolCompleted(event.toolId, event.report!);
          },
          onRoundDelay: (nextRound, delayMs) => {
            reporter.roundDelayStarted(nextRound, delayMs);
          },
          onRoundDelayEnd: () => {
            reporter.roundDelayEnded();
          },
          onConvergence: (round, ratio) => {
            reporter.convergenceDetected(round, ratio, convergenceThreshold);
          },
        });

        reporter.executionFinished();

        // Flatten all tool reports for the manifest
        const allReports = loopResult.rounds.flatMap((r) => r.tools);

        // Write final cross-round notes
        const finalNotes = synthesizeFinal(loopResult.rounds, outputDir);
        safeWriteFile(resolve(outputDir, 'final-notes.md'), finalNotes);

        // Build manifest
        const manifest: RunManifest = {
          timestamp: new Date().toISOString(),
          slug,
          prompt: promptLabel,
          promptSource,
          readOnlyPolicy,
          tools: allReports,
          rounds: loopResult.rounds,
          totalRounds: loopResult.rounds.length,
          durationMs: Date.now() - runStart,
          preset: preset?.name,
        };

        safeWriteFile(
          resolve(outputDir, 'run.json'),
          JSON.stringify(manifest, null, 2),
        );

        reporter.printSummary(manifest, { json: opts.json });
      } catch (e) {
        reporter.executionFinished();
        throw e;
      }
    },
  );
}
