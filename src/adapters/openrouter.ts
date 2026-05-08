import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { Invocation, RunRequest } from '../types.js';
import { debug } from '../ui/logger.js';
import { BaseAdapter } from './base.js';

/**
 * Resolve @file references in a prompt by inlining file contents.
 * Native CLIs (Claude, Codex, Gemini) resolve these from disk automatically.
 * OpenRouter's API has no filesystem access, so we inline them here.
 */
function resolveFileRefs(prompt: string): string {
  return prompt.replace(/^@(.+\.md)$/gm, (_match, filePath: string) => {
    try {
      const content = readFileSync(filePath, 'utf-8');
      const label = basename(filePath);
      return `--- ${label} ---\n${content}\n--- end ${label} ---`;
    } catch (e) {
      debug(
        `Could not resolve file ref "${filePath}": ${e instanceof Error ? e.message : String(e)}`,
      );
      return _match;
    }
  });
}

export class OpenRouterAdapter extends BaseAdapter {
  id = 'openrouter';
  displayName = 'OpenRouter';
  commands = ['openrouter-agent'];
  installUrl =
    'https://github.com/skinnyandbald/counselors#using-openrouter-single-api-key-for-all-models';
  readOnly = { level: 'enforced' as const };
  modelFlag = '--model';
  models = [
    {
      id: 'claude-opus',
      name: 'Claude Opus 4.6 — most capable (Anthropic)',
      recommended: true,
      compoundId: 'or-claude-opus',
      extraFlags: ['--model', 'anthropic/claude-opus-4.6'],
    },
    {
      id: 'gemini-3.1-pro',
      name: 'Gemini 3.1 Pro — fast and capable (Google)',
      recommended: true,
      compoundId: 'or-gemini-3.1-pro',
      extraFlags: ['--model', 'google/gemini-3.1-pro-preview'],
    },
    {
      id: 'gpt-5.5',
      name: 'GPT-5.5 — latest flagship model (OpenAI)',
      recommended: true,
      compoundId: 'or-gpt-5.5',
      extraFlags: ['--model', 'openai/gpt-5.5'],
    },
    {
      id: 'codex-5.4',
      name: 'Codex 5.4 / GPT-5.4 — reasoning model (OpenAI)',
      compoundId: 'or-codex-5.4',
      extraFlags: ['--model', 'openai/gpt-5.4'],
    },
    {
      id: 'claude-sonnet',
      name: 'Claude Sonnet 4.6 — fast and capable (Anthropic)',
      compoundId: 'or-claude-sonnet',
      extraFlags: ['--model', 'anthropic/claude-sonnet-4.6'],
    },
    {
      id: 'gpt-4o',
      name: 'GPT-4o — fast multimodal (OpenAI)',
      compoundId: 'or-gpt-4o',
      extraFlags: ['--model', 'openai/gpt-4o'],
    },
    {
      id: 'llama-4-maverick',
      name: 'Llama 4 Maverick — open source (Meta)',
      compoundId: 'or-llama-4-maverick',
      extraFlags: ['--model', 'meta-llama/llama-4-maverick'],
    },
    {
      id: 'grok-4.20',
      name: 'Grok 4.20 Beta — reasoning flagship (xAI)',
      compoundId: 'or-grok-4.20',
      extraFlags: ['--model', 'x-ai/grok-4.20-beta'],
    },
  ];

  buildInvocation(req: RunRequest): Invocation {
    const args: string[] = [];

    if (req.extraFlags) {
      args.push(...req.extraFlags);
    }

    return {
      cmd: req.binary ?? 'openrouter-agent',
      args,
      stdin: resolveFileRefs(req.prompt),
      cwd: req.cwd,
    };
  }
}
