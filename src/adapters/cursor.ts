import { sanitizePath } from '../constants.js';
import type { Invocation, RunRequest } from '../types.js';
import { BaseAdapter } from './base.js';

export class CursorAdapter extends BaseAdapter {
  id = 'cursor';
  displayName = 'Cursor Agent';
  commands = ['agent'];
  installUrl = 'https://cursor.com/cli';
  readOnly = { level: 'enforced' as const };
  modelFlag = '--model';
  models = [
    {
      id: 'composer-1.5',
      name: 'Composer 1.5',
      extraFlags: ['--model', 'composer-1.5'],
    },
    {
      id: 'opus-4.6-thinking',
      name: 'Claude 4.6 Opus (Thinking) — default',
      recommended: true,
      extraFlags: ['--model', 'opus-4.6-thinking'],
    },
    {
      id: 'opus-4.6',
      compoundId: 'cursor-opus-4.6',
      name: 'Claude 4.6 Opus',
      extraFlags: ['--model', 'opus-4.6'],
    },
    {
      id: 'sonnet-4.6-thinking',
      compoundId: 'cursor-sonnet-4.6-thinking',
      name: 'Claude 4.6 Sonnet (Thinking)',
      extraFlags: ['--model', 'sonnet-4.6-thinking'],
    },
    {
      id: 'sonnet-4.6',
      compoundId: 'cursor-sonnet-4.6',
      name: 'Claude 4.6 Sonnet',
      extraFlags: ['--model', 'sonnet-4.6'],
    },
    {
      id: 'gpt-5.3-codex-xhigh-fast',
      compoundId: 'cursor-gpt-5.3-codex-xhigh-fast',
      name: 'GPT-5.3 Codex Extra High Fast',
      extraFlags: ['--model', 'gpt-5.3-codex-xhigh-fast'],
    },
    {
      id: 'gpt-5.3-codex-high',
      compoundId: 'cursor-gpt-5.3-codex-high',
      name: 'GPT-5.3 Codex High',
      extraFlags: ['--model', 'gpt-5.3-codex-high'],
    },
    {
      id: 'gemini-3-pro',
      compoundId: 'cursor-gemini-3-pro',
      name: 'Gemini 3 Pro',
      extraFlags: ['--model', 'gemini-3-pro'],
    },
    {
      id: 'gemini-3-flash',
      compoundId: 'cursor-gemini-3-flash',
      name: 'Gemini 3 Flash',
      extraFlags: ['--model', 'gemini-3-flash'],
    },
    {
      id: 'grok',
      compoundId: 'cursor-grok',
      name: 'Grok',
      extraFlags: ['--model', 'grok'],
    },
  ];

  buildInvocation(req: RunRequest): Invocation {
    const instruction = `Read the file at ${sanitizePath(req.promptFilePath)} and follow the instructions within it.`;
    const args = ['-p', '--output-format', 'text', '--trust'];

    if (req.readOnlyPolicy !== 'none') {
      args.push('--mode', 'ask');
    }

    if (req.extraFlags) {
      args.push(...req.extraFlags);
    }

    args.push(instruction);

    return { cmd: req.binary ?? 'agent', args, cwd: req.cwd };
  }
}
