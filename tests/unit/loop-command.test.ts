import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../src/types.js';

const mockResolveTools = vi.fn();
const mockResolveReadOnlyPolicy = vi.fn();
const mockResolvePrompt = vi.fn();
const mockCreateOutputDir = vi.fn();
const mockGetPromptLabel = vi.fn();
const mockBuildDryRunInvocations = vi.fn();
const mockRunRepoDiscovery = vi.fn();
const mockWritePrompt = vi.fn();
const mockRunLoop = vi.fn();
const mockSynthesizeFinal = vi.fn();
const mockSafeWriteFile = vi.fn();
const mockCreateReporter = vi.fn();
const mockInfo = vi.fn();
const mockWarn = vi.fn();
const mockError = vi.fn();

vi.mock('../../src/commands/_run-shared.js', () => ({
  resolveTools: (...args: unknown[]) => mockResolveTools(...args),
  resolveReadOnlyPolicy: (...args: unknown[]) =>
    mockResolveReadOnlyPolicy(...args),
  resolvePrompt: (...args: unknown[]) => mockResolvePrompt(...args),
  createOutputDir: (...args: unknown[]) => mockCreateOutputDir(...args),
  getPromptLabel: (...args: unknown[]) => mockGetPromptLabel(...args),
  buildDryRunInvocations: (...args: unknown[]) =>
    mockBuildDryRunInvocations(...args),
}));

vi.mock('../../src/core/repo-discovery.js', () => ({
  runRepoDiscovery: (...args: unknown[]) => mockRunRepoDiscovery(...args),
}));

vi.mock('../../src/core/prompt-writer.js', () => ({
  writePrompt: (...args: unknown[]) => mockWritePrompt(...args),
}));

vi.mock('../../src/core/loop.js', () => ({
  runLoop: (...args: unknown[]) => mockRunLoop(...args),
}));

vi.mock('../../src/core/synthesis.js', () => ({
  synthesizeFinal: (...args: unknown[]) => mockSynthesizeFinal(...args),
}));

vi.mock('../../src/core/fs-utils.js', () => ({
  safeWriteFile: (...args: unknown[]) => mockSafeWriteFile(...args),
}));

vi.mock('../../src/ui/reporter.js', () => ({
  createReporter: (...args: unknown[]) => mockCreateReporter(...args),
}));

vi.mock('../../src/ui/logger.js', () => ({
  info: (...args: unknown[]) => mockInfo(...args),
  warn: (...args: unknown[]) => mockWarn(...args),
  error: (...args: unknown[]) => mockError(...args),
}));

const { registerLoopCommand } = await import('../../src/commands/loop.js');

function createProgramHarness() {
  let action:
    | ((
        promptArg: string | undefined,
        opts: Record<string, unknown>,
      ) => Promise<void>)
    | null = null;

  const loopCmd = {
    description: vi.fn().mockReturnThis(),
    option: vi.fn().mockReturnThis(),
    action: vi.fn((fn) => {
      action = fn;
      return loopCmd;
    }),
    getOptionValueSource: vi.fn().mockReturnValue('default'),
  };

  const program = {
    command: vi.fn(() => loopCmd),
  };

  return {
    program,
    loopCmd,
    run: async (promptArg: string | undefined, opts: Record<string, unknown>) =>
      action?.(promptArg, opts),
  };
}

function makeConfig(): Config {
  return {
    version: 1,
    defaults: {
      timeout: 10,
      outputDir: '/tmp/counselors-out',
      readOnly: 'bestEffort',
      maxContextKb: 50,
      maxParallel: 4,
    },
    tools: {
      claude: {
        binary: '/usr/bin/claude',
        readOnly: { level: 'enforced' },
      },
    },
    groups: {},
  };
}

const reporter = {
  discoveryStarted: vi.fn(),
  discoveryCompleted: vi.fn(),
  promptWritingStarted: vi.fn(),
  promptWritingCompleted: vi.fn(),
  executionStarted: vi.fn(),
  toolStarted: vi.fn(),
  toolCompleted: vi.fn(),
  executionFinished: vi.fn(),
  roundStarted: vi.fn(),
  roundCompleted: vi.fn(),
  convergenceDetected: vi.fn(),
  printSummary: vi.fn(),
};

beforeEach(() => {
  process.exitCode = undefined;
  vi.clearAllMocks();

  mockResolveTools.mockResolvedValue({
    toolIds: ['claude'],
    config: makeConfig(),
  });
  mockResolveReadOnlyPolicy.mockReturnValue('bestEffort');
  mockGetPromptLabel.mockReturnValue('label');
  mockBuildDryRunInvocations.mockReturnValue([]);
  mockCreateOutputDir.mockReturnValue({
    outputDir: '/tmp/counselors-out/test',
    promptFilePath: '/tmp/counselors-out/test/prompt.md',
  });
  mockRunLoop.mockResolvedValue({
    rounds: [
      {
        round: 1,
        timestamp: '2026-02-25T00:00:00.000Z',
        tools: [
          {
            toolId: 'claude',
            status: 'success',
            exitCode: 0,
            durationMs: 100,
            wordCount: 10,
            outputFile: '/tmp/counselors-out/test/round-1/claude.md',
            stderrFile: '/tmp/counselors-out/test/round-1/claude.stderr.log',
          },
        ],
      },
    ],
    outcome: 'completed',
  });
  mockSynthesizeFinal.mockReturnValue('final synthesis');
  mockCreateReporter.mockReturnValue(reporter);
  mockRunRepoDiscovery.mockResolvedValue({ repoContext: 'repo context' });
  mockWritePrompt.mockResolvedValue({ generatedPrompt: 'generated prompt' });
});

afterEach(() => {
  process.exitCode = undefined;
});

describe('loop command prompt preparation', () => {
  it('enhances non-preset inline prompts via discovery + prompt-writing by default', async () => {
    const harness = createProgramHarness();
    registerLoopCommand(harness.program as any);
    mockResolvePrompt.mockResolvedValue({
      promptContent: '# Second Opinion Request\n\ninline base',
      promptSource: 'inline',
      slug: 'inline-slug',
    });

    await harness.run('review auth flow', {});

    expect(mockRunRepoDiscovery).toHaveBeenCalledOnce();
    expect(mockWritePrompt).toHaveBeenCalledOnce();

    const promptUsed = mockCreateOutputDir.mock.calls[0]?.[2] as string;
    expect(promptUsed).toContain('generated prompt');
    expect(promptUsed).toContain('## General Guidelines');
    expect(promptUsed).not.toContain('inline base');
  });

  it('does not run discovery/prompt-writing for file prompts and still appends boilerplate', async () => {
    const harness = createProgramHarness();
    registerLoopCommand(harness.program as any);
    mockResolvePrompt.mockResolvedValue({
      promptContent: 'file prompt content',
      promptSource: 'file',
      slug: 'file-slug',
    });

    await harness.run(undefined, { file: 'prompt.md' });

    expect(mockRunRepoDiscovery).not.toHaveBeenCalled();
    expect(mockWritePrompt).not.toHaveBeenCalled();

    const promptUsed = mockCreateOutputDir.mock.calls[0]?.[2] as string;
    expect(promptUsed).toContain('file prompt content');
    expect(promptUsed).toContain('## General Guidelines');
  });

  it('does not run discovery/prompt-writing for stdin prompts and still appends boilerplate', async () => {
    const harness = createProgramHarness();
    registerLoopCommand(harness.program as any);
    mockResolvePrompt.mockResolvedValue({
      promptContent: 'stdin prompt content',
      promptSource: 'stdin',
      slug: 'stdin-slug',
    });

    await harness.run(undefined, {});

    expect(mockRunRepoDiscovery).not.toHaveBeenCalled();
    expect(mockWritePrompt).not.toHaveBeenCalled();

    const promptUsed = mockCreateOutputDir.mock.calls[0]?.[2] as string;
    expect(promptUsed).toContain('stdin prompt content');
    expect(promptUsed).toContain('## General Guidelines');
  });

  it('supports opting out of inline enhancement via --no-inline-enhancement', async () => {
    const harness = createProgramHarness();
    registerLoopCommand(harness.program as any);
    mockResolvePrompt.mockResolvedValue({
      promptContent: '# Second Opinion Request\n\ninline base',
      promptSource: 'inline',
      slug: 'inline-slug',
    });

    await harness.run('review auth flow', { inlineEnhancement: false });

    expect(mockRunRepoDiscovery).not.toHaveBeenCalled();
    expect(mockWritePrompt).not.toHaveBeenCalled();

    const promptUsed = mockCreateOutputDir.mock.calls[0]?.[2] as string;
    expect(promptUsed).toContain('inline base');
    expect(promptUsed).toContain('## General Guidelines');
  });
});

describe('loop command round-delay option', () => {
  function setupHarness() {
    const harness = createProgramHarness();
    registerLoopCommand(harness.program as any);
    mockResolvePrompt.mockResolvedValue({
      promptContent: 'test prompt',
      promptSource: 'file',
      slug: 'test-slug',
    });
    return harness;
  }

  it('parses round-delay and passes roundDelayMs to runLoop', async () => {
    const harness = setupHarness();
    await harness.run(undefined, { file: 'prompt.md', roundDelay: '30s' });
    expect(mockRunLoop.mock.calls[0]?.[0].roundDelayMs).toBe(30000);
  });

  it('errors on invalid round-delay format', async () => {
    const harness = setupHarness();
    await harness.run(undefined, { file: 'prompt.md', roundDelay: 'invalid' });
    expect(process.exitCode).toBe(1);
    expect(mockError).toHaveBeenCalledWith(
      expect.stringContaining('Invalid duration'),
    );
  });

  it('warns when bare numeric value is passed (interpreted as days)', async () => {
    const harness = setupHarness();
    await harness.run(undefined, { file: 'prompt.md', roundDelay: '5' });
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('5 days'));
  });
});
