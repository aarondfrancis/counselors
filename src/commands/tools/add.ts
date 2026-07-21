import { accessSync, constants } from 'node:fs';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import {
  ANTIGRAVITY_SETTINGS_FILE,
  ensureAntigravityReadOnlySettings,
} from '../../adapters/antigravity.js';
import {
  getAdapter,
  getAllBuiltInAdapters,
  isBuiltInTool,
  resolveAdapter,
} from '../../adapters/index.js';
import { SAFE_ID_RE, sanitizeId } from '../../constants.js';
import { copyAmpSettings } from '../../core/amp-utils.js';
import { addToolToConfig, loadConfig, saveConfig } from '../../core/config.js';
import { discoverTool, findBinary } from '../../core/discovery.js';
import { executeTest } from '../../core/executor.js';
import type { ReadOnlyLevel, ToolConfig } from '../../types.js';
import { error, info, success, warn } from '../../ui/logger.js';
import { createSpinner, formatTestResults } from '../../ui/output.js';
import {
  confirmAction,
  confirmOverwrite,
  promptInput,
  promptSelect,
  selectModelDetails,
} from '../../ui/prompts.js';

const CUSTOM_TOOL_VALUE = '__custom__';

/**
 * Interactive wizard to pick a tool when none is specified.
 * Discovers built-in tools, lets user pick one or add a custom tool.
 * Returns the toolId to add.
 */
async function runAddWizard(): Promise<{ toolId: string; isCustom: boolean }> {
  const spinner = createSpinner('Discovering installed tools...').start();

  const adapters = getAllBuiltInAdapters();
  const discovered: {
    id: string;
    name: string;
    found: boolean;
    version: string | null;
  }[] = [];

  for (const adapter of adapters) {
    const result = discoverTool(adapter.commands);
    discovered.push({
      id: adapter.id,
      name: adapter.displayName,
      found: result.found,
      version: result.version,
    });
  }

  spinner.stop();

  const choices = discovered.map((d) => ({
    name: d.found
      ? `${d.name} (${d.id})${d.version ? ` — ${d.version}` : ''}`
      : `${d.name} (${d.id}) — not installed`,
    value: d.id,
    disabled: !d.found ? '(not installed)' : undefined,
  }));

  choices.push({
    name: 'Custom tool — provide a binary path',
    value: CUSTOM_TOOL_VALUE,
    disabled: undefined,
  });

  const selected = await promptSelect<string>(
    'Which tool would you like to add?',
    choices as any,
  );

  if (selected === CUSTOM_TOOL_VALUE) {
    return { toolId: '', isCustom: true };
  }

  return { toolId: selected, isCustom: false };
}

/**
 * Validate that a binary path exists and is executable.
 * Resolves relative paths against cwd. Also tries `which` for bare commands.
 */
function validateBinary(input: string): string | null {
  // Try as absolute/relative path first
  const resolved = resolve(input);
  try {
    accessSync(resolved, constants.X_OK);
    return resolved;
  } catch {
    // Fall through
  }

  // Try finding it in PATH
  const found = findBinary(input);
  if (found) return found;

  return null;
}

async function addBuiltInTool(
  toolId: string,
  config: ReturnType<typeof loadConfig>,
  nameOverride?: string,
): Promise<void> {
  const adapter = getAdapter(toolId);
  const discovery = discoverTool(adapter.commands);

  if (!discovery.found) {
    error(
      `"${toolId}" binary not found. Install it from: ${adapter.installUrl}`,
    );
    process.exitCode = 1;
    return;
  }

  const selectedModel = await selectModelDetails(toolId, adapter.models);

  let extraFlags: string[] | undefined;
  let defaultName: string;

  if (selectedModel.id === '__custom__') {
    const modelId = await promptInput('Model identifier:');
    if (!modelId.trim()) {
      error('No model identifier provided.');
      process.exitCode = 1;
      return;
    }

    const extraInput = await promptInput(
      'Extra flags (optional, space-separated):',
    );
    const parsedExtra = extraInput.trim() ? extraInput.trim().split(/\s+/) : [];
    extraFlags = [adapter.modelFlag ?? '-m', modelId.trim(), ...parsedExtra];

    defaultName = nameOverride ?? `${toolId}-${sanitizeId(modelId.trim())}`;
  } else {
    extraFlags = selectedModel.extraFlags;
    const fallbackName = selectedModel.id.startsWith(`${toolId}-`)
      ? selectedModel.id
      : `${toolId}-${selectedModel.id}`;
    defaultName = nameOverride ?? selectedModel.compoundId ?? fallbackName;
  }

  let name = nameOverride ?? (await promptInput('Tool name:', defaultName));

  if (!SAFE_ID_RE.test(name)) {
    error(
      `Invalid tool name "${name}". Use only letters, numbers, dots, hyphens, and underscores.`,
    );
    process.exitCode = 1;
    return;
  }

  // Check for conflicts
  if (config.tools[name]) {
    const overwrite = await confirmOverwrite(name);
    if (!overwrite) {
      // Let them pick a different name
      name = await promptInput('Pick a different name:');
      if (!SAFE_ID_RE.test(name)) {
        error(
          `Invalid tool name "${name}". Use only letters, numbers, dots, hyphens, and underscores.`,
        );
        process.exitCode = 1;
        return;
      }
      if (config.tools[name]) {
        error(`"${name}" also exists. Run "counselors tools add" again.`);
        process.exitCode = 1;
        return;
      }
    }
  }

  const toolConfig: ToolConfig = {
    binary: discovery.path!,
    readOnly: { level: adapter.readOnly.level },
    adapter: toolId,
    ...(extraFlags ? { extraFlags } : {}),
  };

  if (toolId === 'antigravity') {
    // Run before saving: if this fails, nothing should be persisted half-configured.
    ensureAntigravityReadOnlySettings();
  }

  const updated = addToolToConfig(config, name, toolConfig);
  saveConfig(updated);
  if (toolId === 'amp') {
    copyAmpSettings();
  }
  if (toolId === 'antigravity') {
    success(`Granted read_file(*) in ${ANTIGRAVITY_SETTINGS_FILE}`);
  }
  success(`Added "${name}" to config.`);

  // For custom models, immediately test to verify the flags work
  if (selectedModel.id === '__custom__') {
    info('Testing tool configuration...');
    const testAdapter = resolveAdapter(name, toolConfig);
    const result = await executeTest(testAdapter, toolConfig, name);
    info(formatTestResults([result]));
    if (!result.passed) {
      warn(
        'The tool was saved to your config but the test failed. You may need to check your API access or flags.',
      );
    }
  }
}

async function collectCustomConfig(
  config: ReturnType<typeof loadConfig>,
  presetId?: string,
): Promise<void> {
  // Get and validate binary
  let binaryPath: string | null = null;
  while (!binaryPath) {
    const binaryInput = await promptInput('Binary path or command:');
    binaryPath = validateBinary(binaryInput);
    if (!binaryPath) {
      warn(`"${binaryInput}" not found or not executable. Please try again.`);
    }
  }

  // Prompt delivery — stdin or CLI argument
  const useStdin = await confirmAction(
    'Does this tool receive prompts via stdin?',
  );

  // Collect flags
  info('');
  info('  Counselors runs tools non-interactively. Your flags MUST include:');
  info(
    '    1. Headless/non-interactive mode (e.g. -p, --non-interactive, --headless)',
  );
  info('    2. Model selection if needed (e.g. --model gpt-4o)');
  info('    3. Output format if needed (e.g. --output-format text)');
  info('');
  if (!useStdin) {
    info('  Counselors will append the prompt as the last CLI argument:');
    info(
      '    "Read the file at <path> and follow the instructions within it."',
    );
  } else {
    info('  Counselors will pipe the prompt text to stdin.');
  }
  info('');
  info('  Example: -p --model gpt-4o --output-format text');
  info('');
  let extraFlags: string[] | undefined;
  const flagsInput = await promptInput('Flags (space-separated):');
  if (flagsInput.trim()) {
    extraFlags = flagsInput.trim().split(/\s+/);
  }

  const readOnlyLevel = await promptSelect<ReadOnlyLevel>(
    'Read-only capability:',
    [
      { name: 'Enforced — tool guarantees read-only', value: 'enforced' },
      {
        name: 'Best effort — tool tries but may not guarantee',
        value: 'bestEffort',
      },
      { name: 'None — tool has full access', value: 'none' },
    ],
  );

  // Get tool ID
  const defaultId =
    presetId ??
    binaryPath
      .split('/')
      .pop()
      ?.replace(/\.[^.]+$/, '') ??
    'custom';
  const toolId = await promptInput(
    'Tool name (used in config and output filenames):',
    defaultId,
  );

  if (!SAFE_ID_RE.test(toolId)) {
    error(
      `Invalid tool name "${toolId}". Use only letters, numbers, dots, hyphens, and underscores.`,
    );
    process.exitCode = 1;
    return;
  }

  // Preview
  info('');
  info('  Tool will be invoked as:');
  const previewArgs = [
    ...(extraFlags ?? []),
    useStdin
      ? '< prompt.md'
      : '"Read the file at <path> and follow the instructions..."',
  ];
  info(`    ${binaryPath} ${previewArgs.join(' ')}`);
  info('');

  if (config.tools[toolId]) {
    const overwrite = await confirmOverwrite(toolId);
    if (!overwrite) {
      const newId = await promptInput('Pick a different name:');
      if (!SAFE_ID_RE.test(newId)) {
        error(
          `Invalid tool name "${newId}". Use only letters, numbers, dots, hyphens, and underscores.`,
        );
        process.exitCode = 1;
        return;
      }
      if (config.tools[newId]) {
        error(`"${newId}" also exists. Run "counselors tools add" again.`);
        process.exitCode = 1;
        return;
      }
      const toolConfig: ToolConfig = {
        binary: binaryPath,
        readOnly: { level: readOnlyLevel },
        ...(useStdin ? { stdin: true } : {}),
        extraFlags,
        custom: true,
      };
      const updated = addToolToConfig(config, newId, toolConfig);
      saveConfig(updated);
      success(`Added "${newId}" to config.`);
      return;
    }
  }

  const toolConfig: ToolConfig = {
    binary: binaryPath,
    readOnly: { level: readOnlyLevel },
    ...(useStdin ? { stdin: true } : {}),
    extraFlags,
    custom: true,
  };

  const updated = addToolToConfig(config, toolId, toolConfig);
  saveConfig(updated);
  success(`Added "${toolId}" to config.`);
}

export function registerAddCommand(program: Command): void {
  program
    .command('add [tool]')
    .description(
      'Add a tool (claude, codex, gemini, amp, antigravity, or custom)',
    )
    .action(async (toolId?: string) => {
      const config = loadConfig();

      if (!toolId) {
        // Interactive wizard
        const result = await runAddWizard();
        if (result.isCustom) {
          await collectCustomConfig(config);
        } else {
          await addBuiltInTool(result.toolId, config);
        }
        return;
      }

      // Direct add (original flow)
      if (isBuiltInTool(toolId)) {
        await addBuiltInTool(toolId, config);
      } else {
        await collectCustomConfig(config, toolId);
      }
    });
}
