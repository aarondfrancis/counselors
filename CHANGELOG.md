# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- New `antigravity` adapter for Google's Antigravity CLI (`agy`), the replacement for the standalone Gemini CLI (shut down for individual users on 2026-06-18)

### Changed
- Standalone release binaries are now built into `release/` instead of `dist/`, decoupling binary artifacts from npm package contents
- Homebrew formula updates now target platform-specific GitHub release binaries directly (macOS/Linux, arm64/x64) instead of the npm tarball

### Fixed
- An adapter's `parseResult` can now supply its own `error` message (previously always overwritten by the dispatcher's generic exitCode-based one) — needed for tools like Antigravity CLI that exit 0 even on a headless permission denial
- npm package publish size is dramatically reduced by excluding standalone compiled binaries from the published `files` list
- Release smoke tests now include Linux (`ubuntu-latest`) for `npm` and `standalone` install paths to catch Linux-only install/runtime breakages
- Homebrew checksum resolution now retries when fetching freshly uploaded release asset checksums, reducing transient CDN propagation failures
- Generated Homebrew formula install logic now validates binary discovery in the staging directory before install, with clearer failure behavior

## [0.5.2] - 2026-02-27

### Added
- `loop --duration` now prints the configured duration at the start of execution so users know how long the session will run

## [0.5.1] - 2026-02-27

### Added
- Child process PIDs are now surfaced during discovery and prompt-writing phases, giving outer agents visibility to monitor long-running prep steps


## [0.5.0] - 2026-02-26

### Added
- `loop --list-presets` to print built-in presets with defaults and summaries
- Presets system for domain-specific multi-round workflows, now with single-word built-ins: `bughunt`, `security`, `invariants`, `regression`, `contracts`, `hotspots`
- Custom presets via YAML files — pass `--preset path/to/preset.yml` to use your own preset definitions
- Non-TTY heartbeat: emits elapsed time and active PIDs to stderr every 60 seconds, preventing outer-agent timeouts during long-running dispatches
- `mkdir` can now be run without a prompt to create only an output directory (no `prompt.md`)
- `upgrade` now prints guidance to refresh the skill template after a successful upgrade

### Changed
- Skill template now warns orchestrating LLMs that dispatch is long-running (10–20+ min) and suggests background execution with progress monitoring
- Built-in presets are now YAML files with schema validation instead of hardcoded TypeScript
- Output directory names include a timestamp prefix for uniqueness (e.g. `1740300000-bughunt`)
- Output paths are always absolute, consistent across single `run` and `loop` commands
- Default tool timeout increased from 9 minutes to 15 minutes
- Non-TTY output is purpose-built for agent consumers with structured lifecycle messages (phase started/completed, tool started/completed with PID and duration)
- Replaced monolithic `ProgressDisplay` with event-driven Reporter interface — `TerminalReporter` for TTY, `AgentReporter` for non-TTY, `NullReporter` for dry-run
- Loop prompt augmentation now uses stronger multi-round guidance: challenge prior findings, use prior findings as leads, and mark overlap status (`confirmed`, `refined`, `invalidated`, `duplicate`)
- `loop` now always appends execution boilerplate, and non-preset inline prompts run discovery + prompt-writing enhancement by default (`--no-inline-enhancement` to opt out); prompt files (`-f`) and stdin prompts skip discovery/prompt-writing
- Duration-based loop runs are now truly unbounded by round count (removed hidden 999-round cap); reporter shows `Round N` when total rounds are open-ended
- Prior-round prompt references are capped to the most recent 8 reports to control prompt growth in long loops
- `mkdir --json` now reports `promptSource: "none"` and `promptFilePath: null` when no prompt input is provided
- Loop output files renamed: `round-synthesis.md` → `round-notes.md`, `final-synthesis.md` → `final-notes.md`
- CLI help text polished for LLM-friendly clarity across commands
- Failed tools now show `see /path/to/tool.stderr` instead of the misleading first line of stderr
- Between loop rounds, reporter shows elapsed time, remaining time (when `--duration` is set), and a Ctrl+C hint

### Security
- Environment variable denylist (`ENV_DENYLIST`) blocks `NODE_OPTIONS`, `LD_PRELOAD`, `DYLD_INSERT_LIBRARIES`, etc. from being re-injected via `invocation.env`, bypassing the allowlist
- Markdown fence injection in `gatherContext` fixed via `safeFence()` that extends the delimiter until it doesn't conflict with content

### Fixed
- Restored `npm run typecheck` health by fixing `runLoop` abort-state narrowing around SIGINT handling
- Null stdio early-return no longer leaks child processes — tracked in `activeChildren` immediately after spawn
- `generateSlug` returns `untitled` instead of empty string for non-alphanumeric input
- `--file` no longer silently ignores `--context` — gathered context is appended to file content when both flags are provided
- Group + explicit tool overlap no longer creates duplicates — tools appearing in both `--group` and `--tools` are deduped while preserving intentional duplicates
- UTF-8 buffer truncation no longer splits multi-byte characters — `truncateUtf8` walks backwards past continuation bytes
- `extractHeadings` uses `report.outputFile` instead of reconstructing the path
- `removeToolFromConfig` cleans up groups left empty after tool removal


## [0.4.12] - 2026-02-19

### Fixed
- `run -f` no longer creates duplicate output directories when the prompt file already lives inside the output base directory
- Gemini adapter appends a prompt instruction to suppress tool-use narration ("I will read...", "I will list...") that was polluting headless output


## [0.4.11] - 2026-02-19

### Added
- Progress display shows child process PIDs and parent PID, with a timing note that sessions may take 10+ minutes — lets users verify processes are alive via `ps` or `tasklist`


## [0.4.10] - 2026-02-16

### Changed
- `tools add` custom model flow now asks for a model identifier instead of raw CLI flags, and constructs the correct flags automatically per adapter

### Fixed
- Gemini CLI with Vertex AI auth now works — `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION` are passed to subprocesses (#13)


## [0.4.9] - 2026-02-16

### Fixed
- Various bug fixes

## [0.4.8] - 2026-02-16

### Added
- `counselors doctor` now warns when multiple installations are detected (e.g. npm + Homebrew + standalone)

### Changed
- `counselors tools test` now shows verbose failure details: timeout detection, stderr content, and actual tool output

## [0.4.7] - 2026-02-16

### Added
- `counselors config` command — prints the config file path and the full resolved configuration as JSON
- `counselors tools test` now prints the exact shell command used for each tool, so users can reproduce tests manually
- `counselors doctor` now validates that every group member references a configured tool

### Fixed
- `counselors tools add <tool>` now defaults to a model-specific name (e.g. `gemini-3-pro`) instead of just the adapter name (e.g. `gemini`)


## [0.4.6] - 2026-02-16

### Fixed
- Gemini 3 models now use the correct `-preview` suffixed API model IDs (`gemini-3-pro-preview`, `gemini-3-flash-preview`), fixing `ModelNotFoundError` when running tools


## [0.4.5] - 2026-02-16

### Fixed
- Various bug fixes

## [0.4.4] - 2026-02-16

### Fixed
- `install.sh` now supports `COUNSELORS_VERSION` pinning and performs a more resilient latest-tag lookup (with optional `GITHUB_TOKEN` auth) to avoid transient GitHub API failures.
- Release standalone smoke test now fetches `install.sh` from the release tag and runs it with `COUNSELORS_VERSION`, eliminating `main` drift and reducing flaky retries.
- Release workflow now computes Homebrew's SHA256 from a locally packed npm tarball and publishes that exact tarball, avoiding npm registry propagation 404s during checksum resolution.
- Binary discovery now includes `PATH` entries in stage-2 fallback scans, reducing Windows false negatives when `where` lookup times out.


## [0.4.3] - 2026-02-16

### Changed
- Gemini model IDs now use Gemini 3 names (`gemini-3-pro`, `gemini-3-flash`) in adapter config and README group examples.
- Release workflow now calls the binaries workflow directly via `workflow_call` instead of relying on tag-push side effects.

### Fixed
- Release workflow now passes an explicit tag to Homebrew update logic in manual (`workflow_dispatch`) runs.
- Homebrew formula updates now pin the npm tarball SHA256 and replace `sha256 :no_check`, so `brew install` succeeds.
- Release workflow now runs parallel smoke tests for npm, standalone installer, and Homebrew installs, validating `--help` and version output.


## [0.4.2] - 2026-02-16

### Fixed
- Various bug fixes



## [0.4.1] - 2026-02-16

### Fixed
- Various bug fixes



## [0.4.0] - 2026-02-16

### Added
- `cleanup` command to delete run output directories older than a configurable age (defaults to 1 day)
- Tool groups (`groups` config, `counselors groups ...`, and `counselors run --group`)
- `upgrade` command with install-method detection (Homebrew, npm, pnpm, yarn, standalone binary)
- Standalone binary releases and `install.sh` curl installer
- Support running the same tool multiple times by repeating it in `--tools` (e.g. `--tools opus,opus,opus`)

### Changed
- Skill template and docs clarify that output directories are configurable via `defaults.outputDir` and `counselors run -o`
- CI runs Windows unit tests on Node 20, 22, and 24 (matching Ubuntu's Node coverage)

### Fixed
- Windows: fixed `.cmd/.bat` execution via `cross-spawn` (stdout capture, synthetic ENOENT), and hardened PATH injection + env allowlisting


## [0.3.4] - 2026-02-10

### Changed
- Agentic quickstart rewritten so agents don't refuse it as social engineering — user installs the CLI, agent only runs config commands with explicit purposes
- Skill template uses second-precision UNIX timestamps instead of millisecond-precision (macOS `date` doesn't support `%N`)
- README adds example prompts and a slash command example to the quickstart


## [0.3.3] - 2026-02-10

### Changed
- Gemini CLI read-only level upgraded from `bestEffort` to `enforced` (tool restrictions are sufficient)
- Doctor no longer warns on `bestEffort` read-only level — only `none` triggers a warning

### Fixed
- Doctor correctly reports Amp deep mode as `bestEffort` instead of `enforced`


## [0.3.2] - 2026-02-10

### Fixed
- `package.json` bin path and repository URL corrected for npm publishing


## [0.3.1] - 2026-02-10

### Changed
- `agent` command clarifies that `counselors skill` prints a reference template to adapt, not a file to blindly copy

### Fixed
- Skill install path in `agent` command now points to `~/.claude/skills/` instead of `~/.claude/commands/`


## [0.3.0] - 2026-02-10

### Added
- Multi-agent parallel dispatch with configurable adapters (Claude, Codex, Gemini, Amp, Custom)
- Project-level `.counselors.json` configuration with defaults overrides
- Tool management commands: add, remove, test, list, discover
- Doctor command for environment diagnostics
- Context gathering with file discovery and prompt building
- Response synthesis across multiple agent outputs
- Amp deep mode support with separate settings file and read-only safety prompt
- Model selection during `init` with per-adapter `extraFlags`
- Skill template output directory prefixed with timestamp for lexical sorting

### Changed
- Simplified `ToolConfig` — removed model concept, unified flags into `extraFlags`

### Security
- Sanitize tool IDs before use in filenames to prevent path traversal
- Allowlist environment variables passed to child processes
- Use `execFileSync` instead of `execSync` in discovery to prevent shell injection
- Restrict project config to `defaults` only — cannot inject `tools`
- Atomic file writes via temp+rename pattern to prevent partial writes

### Fixed
- SIGINT handler properly terminates active child processes
- Release workflow: build before test so integration tests find `dist/cli.js`
- Release script handles blank changelogs instead of failing
- Release workflow accepts leading `v` in version input


[Unreleased]: https://github.com/aarondfrancis/counselors/compare/v0.5.2...HEAD
[0.3.0]: https://github.com/aarondfrancis/counselors/releases/tag/v0.3.0
[0.3.1]: https://github.com/aarondfrancis/counselors/releases/tag/v0.3.1
[0.3.2]: https://github.com/aarondfrancis/counselors/releases/tag/v0.3.2
[0.3.3]: https://github.com/aarondfrancis/counselors/releases/tag/v0.3.3
[0.3.4]: https://github.com/aarondfrancis/counselors/releases/tag/v0.3.4
[0.4.0]: https://github.com/aarondfrancis/counselors/releases/tag/v0.4.0
[0.4.1]: https://github.com/aarondfrancis/counselors/releases/tag/v0.4.1
[0.4.2]: https://github.com/aarondfrancis/counselors/releases/tag/v0.4.2
[0.4.3]: https://github.com/aarondfrancis/counselors/releases/tag/v0.4.3
[0.4.4]: https://github.com/aarondfrancis/counselors/releases/tag/v0.4.4
[0.4.5]: https://github.com/aarondfrancis/counselors/releases/tag/v0.4.5
[0.4.6]: https://github.com/aarondfrancis/counselors/releases/tag/v0.4.6
[0.4.7]: https://github.com/aarondfrancis/counselors/releases/tag/v0.4.7
[0.4.8]: https://github.com/aarondfrancis/counselors/releases/tag/v0.4.8
[0.4.9]: https://github.com/aarondfrancis/counselors/releases/tag/v0.4.9
[0.4.10]: https://github.com/aarondfrancis/counselors/releases/tag/v0.4.10
[0.4.11]: https://github.com/aarondfrancis/counselors/releases/tag/v0.4.11
[0.4.12]: https://github.com/aarondfrancis/counselors/releases/tag/v0.4.12
[0.5.0]: https://github.com/aarondfrancis/counselors/releases/tag/v0.5.0
[0.5.1]: https://github.com/aarondfrancis/counselors/releases/tag/v0.5.1
[0.5.2]: https://github.com/aarondfrancis/counselors/releases/tag/v0.5.2
