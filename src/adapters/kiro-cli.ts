import { countWords } from '../core/text-utils.js';
import type {
  ExecResult,
  Invocation,
  RunRequest,
  ToolReport,
} from '../types.js';
import { BaseAdapter } from './base.js';

export class KiroCliAdapter extends BaseAdapter {
  id = 'kiro-cli';
  displayName = 'Kiro CLI';
  commands = ['kiro-cli'];
  installUrl = 'https://kiro.dev/cli/';
  readOnly = { level: 'enforced' as const };
  modelFlag = '--model';
  models = [
    {
      id: 'auto',
      name: 'Auto — task-optimized model routing (recommended)',
      recommended: true,
      extraFlags: ['--model', 'auto'],
    },
    {
      id: 'claude-opus-4.6',
      name: 'Claude Opus 4.6 — most capable',
      extraFlags: ['--model', 'claude-opus-4.6'],
    },
    {
      id: 'claude-sonnet-4.6',
      name: 'Claude Sonnet 4.6 — balanced',
      extraFlags: ['--model', 'claude-sonnet-4.6'],
    },
    {
      id: 'claude-opus-4.5',
      name: 'Claude Opus 4.5',
      extraFlags: ['--model', 'claude-opus-4.5'],
    },
    {
      id: 'claude-sonnet-4.5',
      name: 'Claude Sonnet 4.5',
      extraFlags: ['--model', 'claude-sonnet-4.5'],
    },
    {
      id: 'claude-sonnet-4',
      name: 'Claude Sonnet 4 — regular use',
      extraFlags: ['--model', 'claude-sonnet-4'],
    },
    {
      id: 'claude-haiku-4.5',
      name: 'Claude Haiku 4.5 — fast, lightweight',
      extraFlags: ['--model', 'claude-haiku-4.5'],
    },
    {
      id: 'deepseek-3.2',
      name: 'DeepSeek V3.2 — experimental',
      extraFlags: ['--model', 'deepseek-3.2'],
    },
    {
      id: 'minimax-m2.5',
      name: 'MiniMax M2.5 — experimental',
      extraFlags: ['--model', 'minimax-m2.5'],
    },
    {
      id: 'minimax-m2.1',
      name: 'MiniMax M2.1 — experimental',
      extraFlags: ['--model', 'minimax-m2.1'],
    },
    {
      id: 'qwen3-coder-next',
      name: 'Qwen3 Coder Next — experimental',
      extraFlags: ['--model', 'qwen3-coder-next'],
    },
  ];

  buildInvocation(req: RunRequest): Invocation {
    const args = ['chat', '--no-interactive', '--wrap', 'never'];

    if (req.extraFlags) {
      args.push(...req.extraFlags);
    }

    if (req.readOnlyPolicy !== 'none') {
      args.push(
        '--trust-tools',
        [
          'fs_read',
          'fs_list',
          'fs_search',
          'web_search',
          'web_fetch',
        ].join(','),
      );
    }

    return {
      cmd: req.binary ?? 'kiro-cli',
      args,
      stdin: req.prompt,
      cwd: req.cwd,
    };
  }

  parseResult(result: ExecResult): Partial<ToolReport> {
    const base = super.parseResult(result);
    let { stdout } = result;

    if (stdout.startsWith('> ')) {
      stdout = stdout.slice(2);
      base.wordCount = countWords(stdout);
    }

    return base;
  }
}
