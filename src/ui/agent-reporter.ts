import type { RunManifest, ToolReport } from '../types.js';
import { formatRunSummary } from './output.js';
import type { Reporter } from './reporter.js';

const HEARTBEAT_INTERVAL = 60_000;

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${secs}s`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

interface ToolState {
  toolId: string;
  phase: 'pending' | 'running' | 'done';
  pid?: number;
}

/**
 * Purpose-built reporter for non-TTY contexts (piped output, outer agents).
 * Plain text to stderr, no ANSI codes. Heartbeat every 60s.
 */
export class AgentReporter implements Reporter {
  private tools = new Map<string, ToolState>();
  private toolOrder: string[] = [];
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private heartbeatStart = 0;
  private executionStart = 0;
  private durationMs: number | undefined;
  private totalRounds: number | null = null;

  // ── Preset phases ──

  discoveryStarted(toolId: string): void {
    this.stderr(`  \u25b8 Discovery phase: ${toolId}`);
  }

  discoveryCompleted(_toolId: string): void {
    this.stderr('  \u2713 Discovery complete');
  }

  promptWritingStarted(toolId: string): void {
    this.stderr(`  \u25b8 Prompt-writing phase: ${toolId}`);
  }

  promptWritingCompleted(_toolId: string): void {
    this.stderr('  \u2713 Prompt-writing complete');
  }

  phasePidReported(toolId: string, pid: number): void {
    this.stderr(`  \u25b8 PID ${pid}  ${toolId} (phase)`);
  }

  // ── Execution lifecycle ──

  executionStarted(
    outputDir: string,
    toolIds: string[],
    opts?: { durationMs?: number },
  ): void {
    this.executionStart = Date.now();
    this.durationMs = opts?.durationMs;
    const displayDir = outputDir;
    this.tools.clear();
    this.toolOrder = [];
    for (const id of toolIds) {
      this.tools.set(id, { toolId: id, phase: 'pending' });
      this.toolOrder.push(id);
    }
    this.stderr(`  Output: ${displayDir}`);
    this.stderr('  \u2139 This may take more than 10 minutes');
    this.stderr(`  PID: ${process.pid}`);
    if (this.durationMs) {
      this.stderr(
        `  Duration: ${formatDuration(this.durationMs)} — no new rounds after that, but in-flight rounds will complete`,
      );
    }
  }

  toolStarted(toolId: string, pid?: number): void {
    const tool = this.tools.get(toolId);
    if (!tool) return;
    tool.phase = 'running';
    tool.pid = pid;
    const pidStr = pid ? `PID ${pid}  ` : '';
    this.stderr(`  \u25b8 ${pidStr}${toolId} started`);
    this.startHeartbeat();
  }

  toolCompleted(toolId: string, report: ToolReport): void {
    const tool = this.tools.get(toolId);
    if (!tool) return;
    tool.phase = 'done';

    const duration = (report.durationMs / 1000).toFixed(1);
    const icon =
      report.status === 'success'
        ? '\u2713'
        : report.status === 'timeout'
          ? '\u23f1'
          : '\u2717';
    this.stderr(
      `  ${icon} ${toolId} done  ${duration}s  ${report.wordCount.toLocaleString()} words`,
    );
    if (report.status !== 'success' && report.stderrFile) {
      this.stderr(`    \u2514 see ${report.stderrFile}`);
    }
  }

  executionFinished(): void {
    this.stopHeartbeat();
  }

  // ── Round management ──

  roundStarted(round: number, totalRounds: number | null): void {
    this.totalRounds = totalRounds;
    if (round > 1) {
      const elapsed = Date.now() - this.executionStart;
      let timing = `${formatDuration(elapsed)} elapsed`;
      if (this.durationMs) {
        const remaining = Math.max(0, this.durationMs - elapsed);
        timing += ` \u00b7 ~${formatDuration(remaining)} remaining`;
      }
      timing += ' \u00b7 Ctrl+C to stop';
      this.stderr(`  ${timing}`);
    }
    const roundLabel =
      totalRounds != null ? `${round}/${totalRounds}` : `${round}`;
    this.stderr(`  \u2500\u2500 Round ${roundLabel} \u2500\u2500`);
    // Reset tool states for new round
    for (const [id] of this.tools) {
      this.tools.set(id, { toolId: id, phase: 'pending' });
    }
  }

  roundCompleted(_round: number): void {
    // No-op for agent — tool completion messages already printed
  }

  roundDelayStarted(nextRound: number, delayMs: number): void {
    const roundLabel =
      this.totalRounds != null
        ? `${nextRound}/${this.totalRounds}`
        : `${nextRound}`;
    this.stderr(
      `  Round ${roundLabel}: starting after ${formatDuration(delayMs)} (Ctrl+C to stop)`,
    );
  }

  roundDelayEnded(): void {}

  convergenceDetected(round: number, ratio: number, threshold: number): void {
    this.stderr(
      `  Convergence at round ${round} (ratio: ${ratio.toFixed(2)} < ${threshold})`,
    );
  }

  // ── Summary ──

  printSummary(manifest: RunManifest, opts: { json?: boolean }): void {
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    } else {
      process.stdout.write(`${formatRunSummary(manifest)}\n`);
    }
  }

  // ── Private ──

  private stderr(line: string): void {
    process.stderr.write(`${line}\n`);
  }

  private startHeartbeat(): void {
    if (this.heartbeatInterval != null) return;
    this.heartbeatStart = Date.now();
    this.heartbeatInterval = setInterval(() => {
      const elapsed = formatDuration(Date.now() - this.heartbeatStart);
      const activePids = this.toolOrder
        .map((id) => this.tools.get(id)!)
        .filter((t) => t.phase === 'running' && t.pid)
        .map((t) => t.pid);
      const pids =
        activePids.length > 0 ? ` (PIDs: ${activePids.join(', ')})` : '';
      this.stderr(`  heartbeat: ${elapsed} elapsed${pids}`);
    }, HEARTBEAT_INTERVAL);
    this.heartbeatInterval.unref();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval == null) return;
    clearInterval(this.heartbeatInterval);
    this.heartbeatInterval = null;
  }
}
