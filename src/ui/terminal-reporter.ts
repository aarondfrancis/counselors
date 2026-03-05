import type { RunManifest, ToolReport } from '../types.js';
import { formatRunSummary } from './output.js';
import type { Reporter } from './reporter.js';

const SPINNER_FRAMES = ['\u25d0', '\u25d3', '\u25d1', '\u25d2'];
const TICK_INTERVAL = 200;
const LABEL_COL_WIDTH = 40;

const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${secs}s`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

type ToolPhase = 'pending' | 'running' | 'done';

interface ToolState {
  toolId: string;
  phase: ToolPhase;
  startedAt?: number;
  report?: ToolReport;
  pid?: number;
}

/**
 * Rich interactive reporter for TTY terminals.
 * Animated spinner, live-updating tool table, phase indicators.
 *
 * Uses the clear/commit/restore pattern:
 *   clearStatus()   → erase the live tool table via ANSI cursor-up
 *   commit(line)    → write a permanent line to stderr
 *   restoreStatus() → re-render the tool table below
 */
export class TerminalReporter implements Reporter {
  private tools = new Map<string, ToolState>();
  private toolOrder: string[] = [];
  private outputDir = '';
  private timer: ReturnType<typeof setInterval> | null = null;
  private frame = 0;
  private lineCount = 0;
  private currentRound: number | null = null;
  private totalRounds: number | null = null;
  private executionActive = false;
  private executionStart = 0;
  private durationMs: number | undefined;
  private delayEndTime: number | undefined;
  private delayNextRound: number | undefined;
  private phaseSpinner: ReturnType<typeof setInterval> | null = null;
  private phaseFrame = 0;
  private phaseText = '';

  // ── Preset phases ──

  discoveryStarted(toolId: string): void {
    this.startPhaseSpinner(`Discovery phase: ${toolId}`);
  }

  discoveryCompleted(_toolId: string): void {
    this.stopPhaseSpinner();
    this.stderr(`  ${GREEN}\u2713${RESET} Discovery complete`);
  }

  promptWritingStarted(toolId: string): void {
    this.startPhaseSpinner(`Prompt-writing phase: ${toolId}`);
  }

  promptWritingCompleted(_toolId: string): void {
    this.stopPhaseSpinner();
    this.stderr(`  ${GREEN}\u2713${RESET} Prompt-writing complete`);
  }

  phasePidReported(toolId: string, pid: number): void {
    this.phaseText = `${this.phaseText.split(' (PID')[0]} (PID ${pid})`;
    this.renderPhase();
  }

  // ── Execution lifecycle ──

  executionStarted(
    outputDir: string,
    toolIds: string[],
    opts?: { durationMs?: number },
  ): void {
    this.executionStart = Date.now();
    this.durationMs = opts?.durationMs;
    this.outputDir = outputDir;
    this.tools.clear();
    this.toolOrder = [];
    for (const id of toolIds) {
      this.tools.set(id, { toolId: id, phase: 'pending' });
      this.toolOrder.push(id);
    }
    this.executionActive = true;
    if (this.durationMs) {
      this.stderr(
        `  Duration: ${formatDuration(this.durationMs)} — no new rounds after that, but in-flight rounds will complete`,
      );
    }
    this.render();
    this.timer = setInterval(() => {
      this.frame++;
      this.render();
    }, TICK_INTERVAL);
  }

  toolStarted(toolId: string, pid?: number): void {
    const tool = this.tools.get(toolId);
    if (!tool) return;
    tool.phase = 'running';
    tool.startedAt = Date.now();
    tool.pid = pid;
  }

  toolCompleted(toolId: string, report: ToolReport): void {
    const tool = this.tools.get(toolId);
    if (!tool) return;
    tool.phase = 'done';
    tool.report = report;
  }

  executionFinished(): void {
    this.executionActive = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.render();
  }

  // ── Round management ──

  roundStarted(round: number, totalRounds: number | null): void {
    this.totalRounds = totalRounds;

    // On rounds after the first, commit the previous round's final table
    // and show timing info
    if (round > 1) {
      this.render();
      this.lineCount = 0;

      const elapsed = Date.now() - this.executionStart;
      let timing = `${formatDuration(elapsed)} elapsed`;
      if (this.durationMs) {
        const remaining = Math.max(0, this.durationMs - elapsed);
        timing += ` \u00b7 ~${formatDuration(remaining)} remaining`;
      }
      timing += ` \u00b7 Ctrl+C to stop`;
      this.stderr(`  ${DIM}${timing}${RESET}`);
    }

    this.currentRound = round;

    // Reset tool states for the new round
    for (const [id] of this.tools) {
      this.tools.set(id, { toolId: id, phase: 'pending' });
    }
  }

  roundCompleted(_round: number): void {
    // No-op — toolCompleted already updated state; render loop shows it
  }

  roundDelayStarted(nextRound: number, delayMs: number): void {
    this.delayEndTime = Date.now() + delayMs;
    this.delayNextRound = nextRound;
  }

  roundDelayEnded(): void {
    this.delayEndTime = undefined;
    this.delayNextRound = undefined;
  }

  convergenceDetected(round: number, ratio: number, threshold: number): void {
    this.clearStatus();
    this.stderr(
      `  ${BOLD}Convergence${RESET} at round ${round} (ratio: ${ratio.toFixed(2)} < ${threshold})`,
    );
    this.restoreStatus();
  }

  // ── Summary ──

  printSummary(manifest: RunManifest, opts: { json?: boolean }): void {
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    } else {
      process.stdout.write(`${formatRunSummary(manifest)}\n`);
    }
  }

  // ── Private: phase spinner (pre-execution) ──

  private startPhaseSpinner(text: string): void {
    this.phaseText = text;
    this.phaseFrame = 0;
    this.renderPhase();
    this.phaseSpinner = setInterval(() => {
      this.phaseFrame++;
      this.renderPhase();
    }, TICK_INTERVAL);
  }

  private stopPhaseSpinner(): void {
    if (this.phaseSpinner) {
      clearInterval(this.phaseSpinner);
      this.phaseSpinner = null;
    }
    // Erase the spinner line
    process.stderr.write('\x1b[1A\x1b[K');
  }

  private renderPhase(): void {
    const spinner = SPINNER_FRAMES[this.phaseFrame % SPINNER_FRAMES.length];
    // Move up if we already rendered a phase line, then overwrite
    if (this.phaseFrame > 0) {
      process.stderr.write('\x1b[1A');
    }
    process.stderr.write(`\x1b[K  ${spinner} ${this.phaseText}\n`);
  }

  // ── Private: tool table rendering ──

  private clearStatus(): void {
    if (this.lineCount > 0) {
      process.stderr.write(`\x1b[${this.lineCount}A`);
      for (let i = 0; i < this.lineCount; i++) {
        process.stderr.write('\x1b[K\n');
      }
      process.stderr.write(`\x1b[${this.lineCount}A`);
    }
  }

  private restoreStatus(): void {
    if (this.executionActive) this.render();
  }

  private stderr(line: string): void {
    process.stderr.write(`${line}\n`);
  }

  private render(): void {
    const lines: string[] = [];
    if (this.currentRound != null) {
      const roundLabel =
        this.totalRounds != null
          ? `${this.currentRound}/${this.totalRounds}`
          : `${this.currentRound}`;
      lines.push(`  Round ${roundLabel}`);
    }
    lines.push(`  ${DIM}Output: ${this.outputDir}${RESET}`);

    // Show info line once any tool has started
    const anyStarted = this.toolOrder.some(
      (id) => this.tools.get(id)!.phase !== 'pending',
    );
    if (anyStarted) {
      lines.push('  \u2139 This may take more than 10 minutes');
      lines.push(`  PID: ${process.pid}`);
    }

    for (const id of this.toolOrder) {
      const tool = this.tools.get(id)!;
      lines.push(this.formatLine(tool));
      if (
        tool.phase === 'done' &&
        tool.report?.status !== 'success' &&
        tool.report?.stderrFile
      ) {
        lines.push(`    ${RED}\u2514 see ${tool.report.stderrFile}${RESET}`);
      }
    }

    if (this.delayEndTime != null) {
      const remaining = Math.max(0, this.delayEndTime - Date.now());
      const remainingSecs = Math.ceil(remaining / 1000);
      const roundLabel =
        this.totalRounds != null
          ? `${this.delayNextRound}/${this.totalRounds}`
          : `${this.delayNextRound}`;
      lines.push(
        `  Round ${roundLabel}: starting after ${remainingSecs}s (Ctrl+C to stop)`,
      );
    }

    // Move cursor up to overwrite previous output
    if (this.lineCount > 0) {
      process.stderr.write(`\x1b[${this.lineCount}A`);
    }

    for (const line of lines) {
      process.stderr.write(`\x1b[K${line}\n`);
    }

    // Clear stale lines if line count decreased
    const staleCount = this.lineCount - lines.length;
    if (staleCount > 0) {
      for (let i = 0; i < staleCount; i++) {
        process.stderr.write('\x1b[K\n');
      }
      process.stderr.write(`\x1b[${staleCount}A`);
    }

    this.lineCount = lines.length;
  }

  private formatLine(tool: ToolState): string {
    const label = tool.toolId;

    switch (tool.phase) {
      case 'pending': {
        const pad = ' '.repeat(Math.max(0, LABEL_COL_WIDTH - label.length));
        return `  \u23f3 ${label}${pad}pending`;
      }
      case 'running': {
        const spinner = SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length];
        const elapsed = tool.startedAt
          ? ((Date.now() - tool.startedAt) / 1000).toFixed(1)
          : '0.0';
        const pidPrefix = tool.pid ? `PID ${tool.pid}  ` : '';
        const fullLabel = `${pidPrefix}${label}`;
        const pad = ' '.repeat(Math.max(0, LABEL_COL_WIDTH - fullLabel.length));
        return `  ${spinner} ${fullLabel}${pad}running  ${elapsed.padStart(6)}s`;
      }
      case 'done': {
        const report = tool.report!;
        const icon =
          report.status === 'success'
            ? '\u2713'
            : report.status === 'timeout'
              ? '\u23f1'
              : '\u2717';
        const duration = (report.durationMs / 1000).toFixed(1);
        const pad = ' '.repeat(Math.max(0, LABEL_COL_WIDTH - label.length));
        return `  ${icon} ${label}${pad}done    ${duration.padStart(6)}s  ${report.wordCount.toLocaleString()} words`;
      }
    }
  }
}
