import type { Invocation, RunRequest } from '../types.js';
import { BaseAdapter } from './base.js';

export class GeminiAdapter extends BaseAdapter {
  id = 'gemini';
  displayName = 'Gemini CLI';
  commands = ['gemini'];
  installUrl = 'https://github.com/google-gemini/gemini-cli';
  readOnly = { level: 'enforced' as const }; 
  models = [
    {
      id: 'gemini-3-pro',
      name: 'Gemini 3 Pro — latest',
      recommended: true,
      extraFlags: ['-m', 'gemini-3-pro-preview'],
    },
    {
      id: 'gemini-3.1-pro',
      name: 'Gemini 3.1 Pro',
      extraFlags: ['-m', 'gemini-3.1-pro-preview'],
    },
    {
      id: 'gemini-2.5-pro',
      name: 'Gemini 2.5 Pro — stable GA',
      extraFlags: ['-m', 'gemini-2.5-pro'],
    },
    {
      id: 'gemini-3-flash',
      name: 'Gemini 3 Flash — fast',
      extraFlags: ['-m', 'gemini-3-flash-preview'],
    },
    {
      id: 'gemini-2.5-flash',
      name: 'Gemini 2.5 Flash — fast GA',
      extraFlags: ['-m', 'gemini-2.5-flash'],
    },
  ];

  buildInvocation(req: RunRequest): Invocation {
    const args = ['-p', ''];

    if (req.extraFlags) {
      args.push(...req.extraFlags);
    }

    if (req.readOnlyPolicy !== 'none') {
      args.push(
        '--extensions',
        '',
        '--allowed-tools',
        'read_file',
        'list_directory',
        'search_file_content',
        'glob',
        'google_web_search',
        'codebase_investigator',
      );
    }

    args.push('--output-format', 'text');

    // Gemini CLI includes tool-use narration ("I will read...", "I will list...")
    // in its headless text output. Append an instruction to suppress it.
    const prompt =
      req.prompt +
      '\n\nIMPORTANT: Do not narrate your tool usage, internal planning, or chain of thought. Start your response directly with your analysis. Do not prefix your response with lines like "I will read..." or "I will list...".';

    return {
      cmd: req.binary ?? 'gemini',
      args,
      stdin: prompt,
      cwd: req.cwd,
    };
  }
}