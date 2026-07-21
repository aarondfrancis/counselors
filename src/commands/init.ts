import type { Command } from 'commander';
import {
  ANTIGRAVITY_SETTINGS_FILE,
  ensureAntigravityReadOnlySettings,
} from '../adapters/antigravity.js';
import { getAllBuiltInAdapters, resolveAdapter } from '../adapters/index.js';
import { AMP_SETTINGS_FILE, CONFIG_DIR } from '../constants.js';
import { copyAmpSettings } from '../core/amp-utils.js';
import { addToolToConfig, loadConfig, saveConfig } from '../core/config.js';
import { discoverTool } from '../core/discovery.js';
import { executeTest } from '../core/executor.js';
import { info, success, warn } from '../ui/logger.js';
import {
  createSpinner,
  formatDiscoveryResults,
  formatTestResults,
} from '../ui/output.js';
import { confirmAction, selectModels, selectTools } from '../ui/prompts.js';

function buildToolConfig(
  id: string,
  adapter: import('../types.js').ToolAdapter,
  binaryPath: string,
) {
  return {
    binary: binaryPath,
    readOnly: { level: adapter.readOnly.level },
    ...(id === 'gemini' || id === 'codex' || id === 'antigravity'
      ? { timeout: 900 }
      : {}),
  };
}

function compoundId(adapterId: string, modelId: string): string {
  if (modelId.startsWith(`${adapterId}-`)) return modelId;
  return `${adapterId}-${modelId}`;
}

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Interactive setup wizard')
    .option(
      '--auto',
      'Non-interactive mode: discover tools, use recommended models, output JSON',
    )
    .action(async (opts: { auto?: boolean }) => {
      // Non-interactive auto mode
      if (opts.auto) {
        const adapters = getAllBuiltInAdapters();
        const discoveries = adapters.map((adapter) => {
          const result = discoverTool(adapter.commands);
          return { adapter, discovery: result };
        });

        const foundTools = discoveries.filter((d) => d.discovery.found);
        if (foundTools.length === 0) {
          info(
            JSON.stringify(
              {
                configured: [],
                notFound: adapters.map((a) => a.id),
                configPath: CONFIG_DIR,
              },
              null,
              2,
            ),
          );
          return;
        }

        let config = loadConfig();
        const configured: {
          id: string;
          adapter: string;
          binary: string;
          version: string | null;
        }[] = [];
        const notFound: string[] = [];

        for (const { adapter, discovery } of discoveries) {
          if (!discovery.found) {
            notFound.push(adapter.id);
            continue;
          }

          for (const model of adapter.models) {
            const cid = model.compoundId ?? compoundId(adapter.id, model.id);
            const toolConfig = {
              ...buildToolConfig(adapter.id, adapter, discovery.path!),
              adapter: adapter.id,
              ...(model.extraFlags ? { extraFlags: model.extraFlags } : {}),
            };
            config = addToolToConfig(config, cid, toolConfig);
            configured.push({
              id: cid,
              adapter: adapter.id,
              binary: discovery.path!,
              version: discovery.version,
            });
          }
        }

        if (configured.some((t) => t.adapter === 'amp')) {
          copyAmpSettings();
        }
        if (configured.some((t) => t.adapter === 'antigravity')) {
          ensureAntigravityReadOnlySettings();
        }

        saveConfig(config);

        info(
          JSON.stringify(
            { configured, notFound, configPath: CONFIG_DIR },
            null,
            2,
          ),
        );
        return;
      }

      // Interactive mode
      info('\nCounselors — setup wizard\n');

      const existingConfig = loadConfig();
      const existingTools = Object.keys(existingConfig.tools);
      if (existingTools.length > 0) {
        warn(
          `Existing config has ${existingTools.length} tool(s). Re-running init will overwrite any tools with the same name.`,
        );
      }

      // Step 1: Discover all built-in tools
      const spinner = createSpinner('Discovering installed tools...').start();
      const adapters = getAllBuiltInAdapters();
      const discoveries = adapters.map((adapter) => {
        const result = discoverTool(adapter.commands);
        return { adapter, discovery: result };
      });
      spinner.stop();

      info(
        formatDiscoveryResults(
          discoveries.map((d) => ({
            ...d.discovery,
            toolId: d.adapter.id,
            displayName: d.adapter.displayName,
          })),
        ),
      );

      const foundTools = discoveries.filter((d) => d.discovery.found);
      if (foundTools.length === 0) {
        warn(
          'No AI CLI tools found. Install at least one before running init.',
        );
        return;
      }

      // Step 2: Select which tools to add
      const selectedIds = await selectTools(
        discoveries.map((d) => ({
          id: d.adapter.id,
          name: d.adapter.displayName,
          found: d.discovery.found,
        })),
      );

      if (selectedIds.length === 0) {
        info('No tools selected. Exiting.');
        return;
      }

      // Step 3: Model selection per tool
      let config = loadConfig();
      const configuredIds: string[] = [];

      for (const id of selectedIds) {
        const d = discoveries.find((x) => x.adapter.id === id)!;
        const models = await selectModels(id, d.adapter.models);

        for (const model of models) {
          const cid = model.compoundId ?? compoundId(id, model.id);
          const toolConfig = {
            ...buildToolConfig(id, d.adapter, d.discovery.path!),
            adapter: id,
            ...(model.extraFlags ? { extraFlags: model.extraFlags } : {}),
          };
          config = addToolToConfig(config, cid, toolConfig);
          configuredIds.push(cid);
        }
      }

      // Step 4: Copy amp settings if amp was selected
      if (selectedIds.includes('amp')) {
        copyAmpSettings();
        success(`Copied amp settings to ${AMP_SETTINGS_FILE}`);
      }
      if (selectedIds.includes('antigravity')) {
        ensureAntigravityReadOnlySettings();
        success(`Granted read_file(*) in ${ANTIGRAVITY_SETTINGS_FILE}`);
      }

      // Step 5: Save config
      saveConfig(config);
      success(`Config saved to ${CONFIG_DIR}`);

      // Step 6: Offer to test
      const runTests = await confirmAction('Run tool tests now?');
      if (runTests) {
        const testResults = [];
        for (const id of configuredIds) {
          const toolConfig = config.tools[id];
          const adapter = resolveAdapter(id, toolConfig);
          const spinner = createSpinner(`Testing ${id}...`).start();
          const result = await executeTest(adapter, toolConfig, id);
          spinner.stop();
          testResults.push(result);
        }
        info(formatTestResults(testResults));
      }
    });
}
