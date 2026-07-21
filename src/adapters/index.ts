import type { ToolAdapter, ToolConfig } from '../types.js';
import { AmpAdapter } from './amp.js';
import { AntigravityAdapter } from './antigravity.js';
import { ClaudeAdapter } from './claude.js';
import { CodexAdapter } from './codex.js';
import { CustomAdapter } from './custom.js';
import { GeminiAdapter } from './gemini.js';

const builtInAdapters: Record<string, () => ToolAdapter> = {
  claude: () => new ClaudeAdapter(),
  codex: () => new CodexAdapter(),
  gemini: () => new GeminiAdapter(),
  amp: () => new AmpAdapter(),
  antigravity: () => new AntigravityAdapter(),
};

export function getAdapter(id: string, config?: ToolConfig): ToolAdapter {
  if (builtInAdapters[id]) {
    return builtInAdapters[id]();
  }
  if (config) {
    return new CustomAdapter(id, config);
  }
  throw new Error(
    `Unknown tool: ${id}. Use "counselors tools add" to configure it.`,
  );
}

export function getAllBuiltInAdapters(): ToolAdapter[] {
  return Object.values(builtInAdapters).map((fn) => fn());
}

export function isBuiltInTool(id: string): boolean {
  return id in builtInAdapters;
}

export function getBuiltInToolIds(): string[] {
  return Object.keys(builtInAdapters);
}

export function resolveAdapter(
  id: string,
  toolConfig: ToolConfig,
): ToolAdapter {
  const baseId = toolConfig.adapter ?? id;
  return isBuiltInTool(baseId)
    ? getAdapter(baseId)
    : new CustomAdapter(id, toolConfig);
}
