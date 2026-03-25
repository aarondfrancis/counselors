import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { KiroCliAdapter } from '../../../src/adapters/kiro-cli.js';
import type { ExecResult, RunRequest } from '../../../src/types.js';

describe('KiroCliAdapter', () => {
  const adapter = new KiroCliAdapter();

  const baseRequest: RunRequest = {
    prompt: 'test prompt',
    promptFilePath: '/tmp/prompt.md',
    toolId: 'kiro-cli',
    outputDir: '/tmp/out',
    readOnlyPolicy: 'enforced',
    timeout: 540,
    cwd: '/tmp',
    extraFlags: ['--model', 'auto'],
  };

  // ── Metadata tests (Requirement 7.1) ──

  it('has correct metadata', () => {
    expect(adapter.id).toBe('kiro-cli');
    expect(adapter.displayName).toBe('Kiro CLI');
    expect(adapter.commands).toEqual(['kiro-cli']);
    expect(adapter.installUrl).toBe('https://kiro.dev/cli/');
    expect(adapter.readOnly.level).toBe('enforced');
    expect(adapter.modelFlag).toBe('--model');
    expect(adapter.models).toHaveLength(11);
    expect(adapter.models[0]).toEqual({
      id: 'auto',
      name: 'Auto — task-optimized model routing (recommended)',
      recommended: true,
      extraFlags: ['--model', 'auto'],
    });
  });

  // ── Model catalog validation tests (Requirements 3.2, 3.3, 3.4) ──

  it('every model entry has non-empty id, name, and correct extraFlags', () => {
    for (const model of adapter.models) {
      expect(model.id).toBeTruthy();
      expect(model.name).toBeTruthy();
      expect(model.extraFlags).toEqual(['--model', model.id]);
    }
  });

  it('exactly one model has recommended: true and its id is auto', () => {
    const recommended = adapter.models.filter((m) => m.recommended === true);
    expect(recommended).toHaveLength(1);
    expect(recommended[0].id).toBe('auto');
  });

  it('buildInvocation passes model extraFlags through to args', () => {
    const req: RunRequest = {
      prompt: 'test',
      promptFilePath: '/tmp/prompt.md',
      toolId: 'kiro-cli',
      outputDir: '/tmp/out',
      readOnlyPolicy: 'enforced',
      timeout: 540,
      cwd: '/tmp',
      extraFlags: ['--model', 'claude-opus-4.6'],
    };
    const inv = adapter.buildInvocation(req);
    expect(inv.args).toContain('--model');
    expect(inv.args).toContain('claude-opus-4.6');
  });

  // ── buildInvocation tests (Requirements 7.2, 7.8) ──

  it('builds invocation with base args and stdin prompt', () => {
    const inv = adapter.buildInvocation(baseRequest);
    expect(inv.args).toContain('chat');
    expect(inv.args).toContain('--no-interactive');
    expect(inv.args).toContain('--wrap');
    expect(inv.args).toContain('never');
    expect(inv.stdin).toBe('test prompt');
    expect(inv.cwd).toBe('/tmp');
  });

  it('includes --trust-tools with read-only tool list when readOnlyPolicy is not none', () => {
    for (const policy of ['enforced', 'bestEffort'] as const) {
      const req = { ...baseRequest, readOnlyPolicy: policy };
      const inv = adapter.buildInvocation(req);
      const idx = inv.args.indexOf('--trust-tools');
      expect(idx).toBeGreaterThan(-1);
      expect(inv.args[idx + 1]).toBe(
        'fs_read,fs_list,fs_search,web_search,web_fetch',
      );
    }
  });

  it('does not include --trust-tools when readOnlyPolicy is none', () => {
    const req = { ...baseRequest, readOnlyPolicy: 'none' as const };
    const inv = adapter.buildInvocation(req);
    expect(inv.args).not.toContain('--trust-tools');
  });

  it('uses req.binary when provided', () => {
    const req = { ...baseRequest, binary: '/custom/path/kiro-cli' };
    const inv = adapter.buildInvocation(req);
    expect(inv.cmd).toBe('/custom/path/kiro-cli');
  });

  it('falls back to "kiro-cli" when req.binary is undefined', () => {
    const inv = adapter.buildInvocation(baseRequest);
    expect(inv.cmd).toBe('kiro-cli');
  });

  it('includes extra flags from req.extraFlags', () => {
    const inv = adapter.buildInvocation(baseRequest);
    expect(inv.args).toContain('--model');
    expect(inv.args).toContain('auto');
  });

  it('handles undefined extraFlags without crashing', () => {
    const req = { ...baseRequest, extraFlags: undefined };
    const inv = adapter.buildInvocation(req);
    expect(inv.args).toContain('chat');
    expect(inv.args).toContain('--no-interactive');
  });

  // ── parseResult tests (Requirements 7.6, 7.7) ──

  it('strips "> " prefix from first line of stdout', () => {
    const result: ExecResult = {
      exitCode: 0,
      stdout: '> Hello world output',
      stderr: '',
      timedOut: false,
      durationMs: 1000,
    };
    const parsed = adapter.parseResult(result);
    expect(parsed.wordCount).toBe(3); // "Hello world output"
  });

  it('passes through stdout without "> " prefix unchanged', () => {
    const result: ExecResult = {
      exitCode: 0,
      stdout: 'Hello world output',
      stderr: '',
      timedOut: false,
      durationMs: 1000,
    };
    const parsed = adapter.parseResult(result);
    expect(parsed.wordCount).toBe(3); // "Hello world output"
  });

  it('preserves status, exitCode, durationMs from base', () => {
    const result: ExecResult = {
      exitCode: 1,
      stdout: '> error output',
      stderr: 'some error',
      timedOut: false,
      durationMs: 2500,
    };
    const parsed = adapter.parseResult(result);
    expect(parsed.status).toBe('error');
    expect(parsed.exitCode).toBe(1);
    expect(parsed.durationMs).toBe(2500);
  });

  it('reports timeout status when timedOut is true', () => {
    const result: ExecResult = {
      exitCode: 1,
      stdout: '',
      stderr: '',
      timedOut: true,
      durationMs: 540000,
    };
    const parsed = adapter.parseResult(result);
    expect(parsed.status).toBe('timeout');
  });

  // ── Property-Based Tests ──

  // Shared arbitrary RunRequest generator
  const arbReadOnlyPolicy = fc.constantFrom(
    'enforced' as const,
    'bestEffort' as const,
    'none' as const,
  );

  const arbFlag = fc
    .string({ minLength: 1, maxLength: 20 })
    .filter((s) => s.trim().length > 0);

  const arbExtraFlags = fc.oneof(
    fc.constant(undefined),
    fc.array(arbFlag, { minLength: 0, maxLength: 5 }),
  );

  const arbRunRequest = (): fc.Arbitrary<RunRequest> =>
    fc
      .record({
        prompt: fc.string({ minLength: 0, maxLength: 200 }),
        readOnlyPolicy: arbReadOnlyPolicy,
        extraFlags: arbExtraFlags,
        binary: fc.oneof(
          fc.constant(undefined),
          fc
            .string({ minLength: 1, maxLength: 30 })
            .filter((s) => s.trim().length > 0),
        ),
      })
      .map((r) => ({
        prompt: r.prompt,
        promptFilePath: '/tmp/prompt.md',
        toolId: 'kiro-cli',
        outputDir: '/tmp/out',
        readOnlyPolicy: r.readOnlyPolicy,
        timeout: 540,
        cwd: '/tmp',
        binary: r.binary,
        extraFlags: r.extraFlags,
      }));

  // Feature: kiro-cli-adapter, Property 1: Base args invariant
  it('property: base args are always present', () => {
    fc.assert(
      fc.property(arbRunRequest(), (req) => {
        const inv = adapter.buildInvocation(req);
        expect(inv.args).toContain('chat');
        expect(inv.args).toContain('--no-interactive');
        expect(inv.args).toContain('--wrap');
        expect(inv.args).toContain('never');
      }),
      { numRuns: 100 },
    );
  });

  // Feature: kiro-cli-adapter, Property 2: Stdin prompt delivery
  it('property: stdin always contains the prompt', () => {
    fc.assert(
      fc.property(arbRunRequest(), (req) => {
        const inv = adapter.buildInvocation(req);
        expect(inv.stdin).toBe(req.prompt);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: kiro-cli-adapter, Property 3: No positional prompt in args
  it('property: args never contain the prompt text or file-read instruction', () => {
    fc.assert(
      fc.property(
        arbRunRequest().filter((r) => r.prompt.length > 0),
        (req) => {
          const inv = adapter.buildInvocation(req);
          expect(inv.args).not.toContain(req.prompt);
          expect(inv.args.join(' ')).not.toContain('Read the file');
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: kiro-cli-adapter, Property 4: Trust tools enforcement based on readOnlyPolicy
  it('property: --trust-tools present when readOnlyPolicy is not none, absent when none', () => {
    fc.assert(
      fc.property(arbRunRequest(), (req) => {
        const inv = adapter.buildInvocation(req);
        expect(inv.args).not.toContain('--trust-all-tools');
        const idx = inv.args.indexOf('--trust-tools');
        if (req.readOnlyPolicy !== 'none') {
          expect(idx).toBeGreaterThan(-1);
          expect(inv.args[idx + 1]).toBe(
            'fs_read,fs_list,fs_search,web_search,web_fetch',
          );
        } else {
          expect(idx).toBe(-1);
        }
      }),
      { numRuns: 100 },
    );
  });

  // Feature: kiro-cli-adapter, Property 6: Extra flags inclusion
  it('property: every extra flag appears in args', () => {
    fc.assert(
      fc.property(
        arbRunRequest().filter(
          (r) => r.extraFlags !== undefined && r.extraFlags.length > 0,
        ),
        (req) => {
          const inv = adapter.buildInvocation(req);
          for (const flag of req.extraFlags!) {
            expect(inv.args).toContain(flag);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: kiro-cli-adapter, Property 7: Binary fallback
  it('property: cmd equals req.binary when provided, kiro-cli otherwise', () => {
    fc.assert(
      fc.property(arbRunRequest(), (req) => {
        const inv = adapter.buildInvocation(req);
        if (req.binary !== undefined) {
          expect(inv.cmd).toBe(req.binary);
        } else {
          expect(inv.cmd).toBe('kiro-cli');
        }
      }),
      { numRuns: 100 },
    );
  });

  // Feature: kiro-cli-adapter, Property 8: parseResult prefix stripping and field preservation
  it('property: parseResult preserves base fields and strips "> " prefix correctly', () => {
    const arbExecResult = fc
      .record({
        exitCode: fc.oneof(fc.constant(0), fc.constant(1)),
        stdout: fc.oneof(
          fc.string({ minLength: 0, maxLength: 200 }),
          fc.string({ minLength: 0, maxLength: 200 }).map((s) => `> ${s}`),
        ),
        stderr: fc.string({ minLength: 0, maxLength: 50 }),
        timedOut: fc.boolean(),
        durationMs: fc.nat({ max: 600000 }),
      })
      .map((r) => r as ExecResult);

    fc.assert(
      fc.property(arbExecResult, (result) => {
        const parsed = adapter.parseResult(result);

        // Field preservation
        expect(parsed.exitCode).toBe(result.exitCode);
        expect(parsed.durationMs).toBe(result.durationMs);
        expect(parsed.status).toBe(
          result.timedOut
            ? 'timeout'
            : result.exitCode === 0
              ? 'success'
              : 'error',
        );

        // Prefix stripping
        if (result.stdout.startsWith('> ')) {
          const stripped = result.stdout.slice(2);
          const expectedWords = stripped.split(/\s+/).filter(Boolean).length;
          expect(parsed.wordCount).toBe(expectedWords);
        } else {
          const expectedWords = result.stdout
            .split(/\s+/)
            .filter(Boolean).length;
          expect(parsed.wordCount).toBe(expectedWords);
        }
      }),
      { numRuns: 100 },
    );
  });
});
