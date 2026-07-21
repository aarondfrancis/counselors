import { describe, expect, it } from 'vitest';
import { resolveAdapter } from '../../../src/adapters/index.js';
import type { ToolConfig } from '../../../src/types.js';

describe('resolveAdapter', () => {
  it('resolves compound codex ID to CodexAdapter', () => {
    const config: ToolConfig = {
      binary: '/usr/local/bin/codex',
      adapter: 'codex',
      readOnly: { level: 'none' },
    };

    const adapter = resolveAdapter('codex-5.3-xhigh', config);
    expect(adapter.id).toBe('codex');
  });

  it('resolves compound amp ID to AmpAdapter', () => {
    const config: ToolConfig = {
      binary: '/usr/local/bin/amp',
      adapter: 'amp',
      readOnly: { level: 'enforced' },
    };

    const adapter = resolveAdapter('amp-smart', config);
    expect(adapter.id).toBe('amp');
  });

  it('resolves compound gemini ID to GeminiAdapter', () => {
    const config: ToolConfig = {
      binary: '/usr/local/bin/gemini',
      adapter: 'gemini',
      readOnly: { level: 'bestEffort' },
    };

    const adapter = resolveAdapter('gemini-3-pro', config);
    expect(adapter.id).toBe('gemini');
  });

  it('resolves compound antigravity ID to AntigravityAdapter', () => {
    const config: ToolConfig = {
      binary: '/usr/local/bin/agy',
      adapter: 'antigravity',
      readOnly: { level: 'enforced' },
    };

    const adapter = resolveAdapter('antigravity-flash-high', config);
    expect(adapter.id).toBe('antigravity');
  });

  it('resolves plain built-in ID without adapter field', () => {
    const config: ToolConfig = {
      binary: '/usr/local/bin/claude',
      readOnly: { level: 'enforced' },
    };

    const adapter = resolveAdapter('claude', config);
    expect(adapter.id).toBe('claude');
  });

  it('returns CustomAdapter for unknown adapter', () => {
    const config: ToolConfig = {
      binary: '/usr/local/bin/my-tool',
      readOnly: { level: 'none' },
      custom: true,
    };

    const adapter = resolveAdapter('my-custom-tool', config);
    expect(adapter.id).toBe('my-custom-tool');
  });
});
