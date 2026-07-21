import { sanitizePath } from '../constants.js';
import type { Invocation, RunRequest } from '../types.js';
import { BaseAdapter } from './base.js';

export class ClaudeAdapter extends BaseAdapter {
  id = 'claude';
  displayName = 'Claude Code';
  commands = ['claude'];
  installUrl = 'https://docs.anthropic.com/en/docs/claude-code';
  readOnly = { level: 'enforced' as const };
  modelFlag = '--model';
  models = [
    {
      id: 'fable',
      compoundId: 'claude-fable-high',
      name: 'Fable 5 — most capable, high effort',
      recommended: true,
      extraFlags: ['--model', 'fable', '--effort', 'high'],
    },
    {
      id: 'fable',
      compoundId: 'claude-fable',
      name: 'Fable 5 — most capable, default effort',
      extraFlags: ['--model', 'fable'],
    },
    {
      id: 'opus',
      name: 'Opus 4.6 — most capable',
      extraFlags: ['--model', 'opus'],
    },
    {
      id: 'sonnet',
      name: 'Sonnet 4.5 — fast and capable',
      extraFlags: ['--model', 'sonnet'],
    },
    {
      id: 'haiku',
      name: 'Haiku 4.5 — fastest, most affordable',
      extraFlags: ['--model', 'haiku'],
    },
  ];

  buildInvocation(req: RunRequest): Invocation {
    const instruction = `Read the file at ${sanitizePath(req.promptFilePath)} and follow the instructions within it.`;
    const args = ['-p', '--output-format', 'text'];

    if (req.extraFlags) {
      args.push(...req.extraFlags);
    }

    if (req.readOnlyPolicy !== 'none') {
      args.push(
        '--tools',
        'Read,Glob,Grep,WebFetch,WebSearch',
        '--allowedTools',
        'Read,Glob,Grep,WebFetch,WebSearch',
        '--strict-mcp-config',
      );
    }

    args.push(instruction);

    return { cmd: req.binary ?? 'claude', args, cwd: req.cwd };
  }
}
