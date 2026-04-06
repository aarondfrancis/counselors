import { sanitizePath } from '../constants.js';
import type { Invocation, RunRequest } from '../types.js';
import { BaseAdapter } from './base.js';

const READ_ONLY_PERMISSIONS = JSON.stringify({
  '*': 'deny',
  bash: 'deny',
  edit: 'deny',
  read: {
    '*': 'allow',
    '*.env': 'deny',
    '*.env.*': 'deny',
    '*.env.example': 'allow',
  },
  glob: 'allow',
  grep: 'allow',
  list: 'allow',
  webfetch: 'allow',
  websearch: 'allow',
  codesearch: 'allow',
  lsp: 'allow',
});

export class OpenCodeAdapter extends BaseAdapter {
  id = 'opencode';
  displayName = 'OpenCode';
  commands = ['opencode'];
  installUrl = 'https://opencode.ai/docs/';
  readOnly = { level: 'enforced' as const };
  modelFlag = '--model';
  models = [
    {
      id: 'openai/gpt-5.4',
      compoundId: 'opencode-openai-gpt-5.4',
      name: 'GPT-5.4 via OpenCode - most capable',
      recommended: true,
      extraFlags: ['--model', 'openai/gpt-5.4'],
    },
    {
      id: 'openai/gpt-5.4-mini',
      compoundId: 'opencode-openai-gpt-5.4-mini',
      name: 'GPT-5.4 Mini via OpenCode - faster',
      extraFlags: ['--model', 'openai/gpt-5.4-mini'],
    },
    {
      id: 'openai/gpt-5.3-codex',
      compoundId: 'opencode-openai-gpt-5.3-codex',
      name: 'GPT-5.3 Codex via OpenCode - coding focused',
      extraFlags: ['--model', 'openai/gpt-5.3-codex'],
    },
  ];

  buildInvocation(req: RunRequest): Invocation {
    const instruction = `Read the file at ${sanitizePath(req.promptFilePath)} and follow the instructions within it. Do not narrate your tool usage or internal planning. Start directly with the answer.`;
    const args = ['run', '--pure'];

    if (req.extraFlags) {
      args.push(...req.extraFlags);
    }

    args.push(instruction);

    return {
      cmd: req.binary ?? 'opencode',
      args,
      env:
        req.readOnlyPolicy !== 'none'
          ? { OPENCODE_PERMISSION: READ_ONLY_PERMISSIONS }
          : undefined,
      cwd: req.cwd,
    };
  }
}
