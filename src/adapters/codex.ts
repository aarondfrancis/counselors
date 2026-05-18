import { sanitizePath } from '../constants.js';
import type { Invocation, RunRequest } from '../types.js';
import { BaseAdapter } from './base.js';

export class CodexAdapter extends BaseAdapter {
  id = 'codex';
  displayName = 'OpenAI Codex';
  commands = ['codex'];
  installUrl = 'https://github.com/openai/codex';
  readOnly = { level: 'enforced' as const };
  models = [
    {
      id: 'gpt-5.4',
      compoundId: 'codex-5.4-high',
      name: 'GPT-5.4 — high reasoning',
      recommended: true,
      extraFlags: ['-m', 'gpt-5.4', '-c', 'model_reasoning_effort=high'],
    },
    {
      id: 'gpt-5.4',
      compoundId: 'codex-5.4-xhigh',
      name: 'GPT-5.4 — xhigh reasoning',
      extraFlags: ['-m', 'gpt-5.4', '-c', 'model_reasoning_effort=xhigh'],
    },
    {
      id: 'gpt-5.4',
      compoundId: 'codex-5.4-medium',
      name: 'GPT-5.4 — medium reasoning',
      extraFlags: [
        '-m',
        'gpt-5.4',
        '-c',
        'model_reasoning_effort=medium',
      ],
    },
    {
      id: 'gpt-5.3-codex',
      compoundId: 'codex-5.3-high',
      name: 'GPT-5.3 Codex — high reasoning',
      extraFlags: ['-m', 'gpt-5.3-codex', '-c', 'model_reasoning_effort=high'],
    },
    {
      id: 'gpt-5.3-codex',
      compoundId: 'codex-5.3-xhigh',
      name: 'GPT-5.3 Codex — xhigh reasoning',
      extraFlags: ['-m', 'gpt-5.3-codex', '-c', 'model_reasoning_effort=xhigh'],
    },
    {
      id: 'gpt-5.3-codex',
      compoundId: 'codex-5.3-medium',
      name: 'GPT-5.3 Codex — medium reasoning',
      extraFlags: [
        '-m',
        'gpt-5.3-codex',
        '-c',
        'model_reasoning_effort=medium',
      ],
    },
  ];

  buildInvocation(req: RunRequest): Invocation {
    const instruction = `Read the file at ${sanitizePath(req.promptFilePath)} and follow the instructions within it.`;
    const args = ['exec'];

    if (req.readOnlyPolicy !== 'none') {
      args.push('--sandbox', 'read-only');
    }

    args.push('-c', 'web_search=live', '--skip-git-repo-check');

    if (req.extraFlags) {
      args.push(...req.extraFlags);
    }

    args.push(instruction);

    return { cmd: req.binary ?? 'codex', args, cwd: req.cwd };
  }
}
