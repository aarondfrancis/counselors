# counselors

By [Aaron Francis](https://aaronfrancis.com), creator of [Faster.dev](https://faster.dev) and [Solo](https://soloterm.com).

Fan out prompts to multiple AI coding agents in parallel.

`counselors` dispatches the same prompt to Claude, Codex, Gemini, Antigravity, Amp, or custom tools simultaneously, collects their responses, and writes everything to a structured output directory.

No MCP servers, no direct API integrations, no complex configuration. It just calls your locally installed CLI tools.

## Will this get me banned from my provider?

Counselors only uses providers' **first-party CLI tools**. It does not call provider APIs directly, it does not extract or reuse auth tokens, and it does not do anything "tricky" behind the scenes. It literally runs the official CLI binaries you already installed, the same way you would from your terminal.

You are still subject to each provider's terms and rate limits. Counselors is just an orchestrator around the CLIs.

## Agentic quickstart

Install the CLI yourself first (pick one):

- npm (requires Node 20+): `npm install -g counselors`
- Homebrew: `brew install aarondfrancis/homebrew-tap/counselors`
- Standalone binary: `curl -fsSL https://github.com/aarondfrancis/counselors/raw/main/install.sh | bash`

Then paste this to your AI coding agent:

```
Run `counselors init --auto` to discover and configure installed AI CLIs. Then run `counselors skill` to see how to create a skill for the counselors CLI.
```

Your agent will configure available tools and set up the `/counselors` slash command.

### Updating your skill

The recommended skill template changes over time. If you already installed `/counselors` in your agent system, don’t blindly overwrite it.

Copy/paste this into your AI coding agent:

```
The counselors CLI has an updated skill template.

1. Run `counselors skill` and capture the full output.
2. Open my existing counselors skill file and compare VERY CAREFULLY for anything that changed.
3. Apply the updates manually; do not blindly overwrite.
4. If you need more context, check the git history for the skill template here:
   https://github.com/aarondfrancis/counselors/commits/main/src/commands/skill.ts
```

**How it works:**

1. You invoke the Counselors skill with a prompt
2. Your agent gathers context from the codebase
3. Your agent asks which other agents you want to consult
4. Counselors fans out to those agents in parallel for independent research
5. Each agent writes a structured markdown report
6. Your main agent synthesizes and presents the results

**Example:** after a big refactor, ask your agents for a second opinion:

```
/counselors We just completed a major refactor of the authentication module.
Review the changes for edge cases, test gaps, or regressions we might have missed.
```

Your main agent handles the rest — it gathers relevant code, recent commits, and assembles a detailed prompt before dispatching to the counselors.

## Human quickstart

Install the CLI (pick one):

- npm (requires Node 20+): `npm install -g counselors`
- Homebrew: `brew install aarondfrancis/homebrew-tap/counselors`
- Standalone binary: `curl -fsSL https://github.com/aarondfrancis/counselors/raw/main/install.sh | bash`

```bash
# Discover installed AI CLIs and create a config
counselors init

# Send a prompt to all configured tools
counselors run "Trace the state management flow in the dashboard and flag any brittleness or stale state bugs"

# Send to specific tools only
counselors run -t claude,codex "Review src/api/ for security issues and missing edge cases"
```

## Supported tools

| Tool | Adapter | Read-Only | Install |
|------|---------|-----------|---------|
| Claude Code | `claude` | enforced | [docs](https://docs.anthropic.com/en/docs/claude-code) |
| OpenAI Codex | `codex` | enforced | [github](https://github.com/openai/codex) |
| Gemini CLI | `gemini` | enforced | [github](https://github.com/google-gemini/gemini-cli) |
| Antigravity CLI | `antigravity` | enforced | [docs](https://antigravity.google/docs/cli/install) |
| Amp CLI | `amp` | enforced | [ampcode.com](https://ampcode.com) |
| Custom | user-defined | configurable | — |

## Commands

### `run [prompt]`

Dispatch a prompt to configured tools in parallel.

```bash
counselors run "Your prompt here"
counselors run -f prompt.md              # Use a prompt file
echo "prompt" | counselors run           # Read from stdin
counselors run --dry-run "Show plan"     # Preview without executing
counselors run -t opus,opus,opus "Review this"  # Run the same tool multiple times
```

| Flag | Description |
|------|-------------|
| `-f, --file <path>` | Use a prompt file (no wrapping) |
| `-t, --tools <tools>` | Comma-separated tool IDs |
| `-g, --group <groups>` | Comma-separated group name(s) (expands to tool IDs) |
| `--context <paths>` | Gather context from paths (comma-separated, or `.` for git diff) |
| `--read-only <level>` | `strict`, `best-effort`, `off` (defaults to config `readOnly`) |
| `--dry-run` | Show what would run without executing |
| `--json` | Output manifest as JSON |
| `-o, --output-dir <dir>` | Base output directory |

### `loop [prompt]`

Multi-round dispatch — agents iterate, seeing prior outputs each round.

Each round dispatches to all tools in parallel. Starting from round 2, each agent receives the outputs from all prior rounds, so it can build on previous analysis and avoid repeating findings.

```text
input: user prompt/focus (e.g.: "focus on the auth module", "look at the sidebar component")
  |
  +--> with --preset:
  |      [repo discovery phase] --> [prompt-writing phase] --> execution prompt (includes boilerplate)
  +--> without --preset:
         inline arg prompt:
           default: [repo discovery phase] --> [prompt-writing phase] --> enhanced execution prompt
           opt-out: --no-inline-enhancement (skip discovery/prompt-writing)
         file/stdin prompt: used as provided (discovery/prompt-writing skipped)

all modes: execution boilerplate is always appended

execution prompt
      |
      v
+------------------------------- loop rounds -------------------------------+
| round 1: dispatch to all selected tools in parallel                       |
|          write per-tool outputs + round notes                             |
|                                                                           |
| round N>1: execution prompt + references to prior round outputs           |
|            (new findings, challenge/refine prior findings)                |
|            dispatch in parallel, write outputs + notes                    |
|                                                                           |
| stop when:                                                                |
| - max rounds reached, or                                                  |
| - duration expires, or                                                    |
| - convergence threshold reached, or                                       |
| - user aborts (Ctrl+C after current round)                                |
+---------------------------------------------------------------------------+
      |
      v
final notes + run manifest
```

```text
Round behavior:

round 1 prompt = base execution prompt


round N prompt = base execution prompt
               // Base execution prompt is amended with...
               + "Prior Round Outputs" section
               + @refs to recent prior tool outputs
               + instruction to avoid duplicate findings, challenge/refine 
                 prior claims, and expand from prior leads
```

```bash
counselors loop "Find and fix test gaps in src/auth/" --rounds 5
counselors loop --duration 30m "Hunt for edge cases"
counselors loop --preset bughunt "src/api" --tools opus,codex
counselors loop --preset hotspots "critical request path" --group smart
counselors loop --list-presets
```

| Flag | Description |
|------|-------------|
| `--rounds <N>` | Number of dispatch rounds (default: 3) |
| `--duration <time>` | Max total duration (e.g. `"30m"`, `"1h"`). If set without `--rounds`, runs unlimited rounds until time expires |
| `--preset <name-or-path>` | Use a built-in preset (e.g. `"bughunt"`) or a custom `.yml/.yaml` preset file |
| `--list-presets` | List built-in presets and exit |
| `--no-inline-enhancement` | For non-preset inline prompts, skip discovery + prompt-writing enhancement |

Plus all `run` flags: `-f`, `-t`, `-g`, `--context`, `--read-only`, `--dry-run`, `--json`, `-o`.

**SIGINT handling:** First Ctrl+C finishes the current round gracefully. Second Ctrl+C force-exits immediately.

**Presets** provide domain-specific multi-round workflows.

Built-ins:
- `bughunt` — bugs, edge cases, and missing test coverage
- `security` — exploitable vulnerabilities and high-impact security flaws
- `invariants` — impossible states and state synchronization problems
- `regression` — behavior changes likely to break existing callers/users
- `contracts` — mismatches between API producers and consumers
- `hotspots` — high-impact bottlenecks, including O(n^2)+ patterns

Custom presets (code-grounded):

```yaml
name: auth-audit
description: |
  Audit authentication and authorization code paths for real issues.
  Ground every claim in repository evidence.
  For each finding, include concrete file paths and explain the exact control/data flow.
  Do not speculate about behavior that is not visible in code.
defaultRounds: 3
defaultReadOnly: bestEffort
```

```bash
counselors loop --preset ./presets/auth-audit.yml "src/auth and middleware"
counselors loop --preset ./presets/auth-audit.yml "session + token flows" --dry-run
```

Guidelines for "truth of the code" presets:
- Write `description` so findings must cite concrete evidence (file paths, functions, branches, tests).
- Require the agent to separate observed behavior from assumptions and call out unknowns explicitly.
- Ask for reproducible checks (commands/tests) for each high-confidence claim.
- Keep the focus target narrow in the prompt argument (specific dirs, modules, or request paths).

### `mkdir [prompt]`

Create a counselors output directory and optionally write `prompt.md` without dispatching.

If you do not provide a prompt (arg, `-f`, or stdin), `mkdir` creates only the containing directory.

Useful when an orchestrating agent wants counselors to own output-dir creation and just return paths.

```bash
counselors mkdir --json
counselors mkdir "Review the auth flow for edge cases" --json
echo "prompt" | counselors mkdir --json
cat prompt.md | counselors mkdir --json
counselors mkdir -f prompt.md --json
```

The JSON output includes:
- `outputDir`
- `promptFilePath` (`null` when no prompt was provided)
- `slug`
- `promptSource` (`none`, `inline`, `file`, or `stdin`)

### `init`

Interactive setup wizard. Discovers installed AI CLIs, lets you pick tools and models, runs validation tests.

```bash
counselors init          # Interactive
counselors init --auto   # Non-interactive: discover tools, use defaults, output JSON
```

### `doctor`

Check configuration health — verifies config file, tool binaries, versions, and read-only capabilities.

```bash
counselors doctor
```

### `upgrade`

Detect how `counselors` was installed and upgrade using the matching method when possible.

Supported:
- Homebrew
- npm global
- pnpm global
- yarn global (classic)
- Standalone binary installs (safe paths only: `~/.local/bin`, `~/bin`)

```bash
counselors upgrade
counselors upgrade --check        # Show method/version only
counselors upgrade --dry-run      # Show what would run
counselors upgrade --force        # Force standalone self-upgrade outside safe locations
```

### `cleanup`

Delete run output directories older than a given age. Defaults to older than 1 day and uses your configured output directory (`defaults.outputDir`).

```bash
counselors cleanup
counselors cleanup --dry-run --older-than 7d
counselors cleanup --older-than 36h --yes
```

### `config`

Print the config file path and the full resolved configuration as JSON.

```bash
counselors config
```

### `tools`

Manage configured tools.

| Command | Description |
|---------|-------------|
| `tools discover` | Find installed AI CLIs on your system |
| `tools add [tool]` | Add a built-in or custom tool |
| `tools remove [tool]` | Remove tool(s) — interactive if no argument |
| `tools rename <old> <new>` | Rename a tool ID |
| `tools list` / `ls` | List configured tools (`-v` for full config) |
| `tools test [tools...]` | Test tools with a quick "reply OK" prompt |

### `groups`

Manage predefined groups of tool IDs for easier reuse.

```bash
counselors groups list
counselors groups add smart --tools claude-opus,codex-5.3-xhigh,gemini-3-pro
counselors groups add fast --tools codex-5.3-high,gemini-3-flash
counselors groups add opus-swarm --tools claude-opus,claude-opus,claude-opus
counselors groups remove fast
```

### `agent`

Print setup and skill installation instructions.

### `skill`

Print a `/counselors` slash-command template for use inside Claude Code or other agents.

## Configuration

### Global config

`~/.config/counselors/config.json` (respects `XDG_CONFIG_HOME`)

```jsonc
{
  "version": 1,
  "defaults": {
    "timeout": 540,
    "outputDir": "./agents/counselors",
    "readOnly": "bestEffort",
    "maxContextKb": 50,
    "maxParallel": 4
  },
  "tools": {
    "claude": {
      "binary": "/usr/local/bin/claude",
      "adapter": "claude",
      "readOnly": { "level": "enforced" },
      "extraFlags": ["--model", "opus"]
    }
  },
  "groups": {
    "smart": ["claude-opus", "codex-5.3-xhigh", "gemini-3-pro"],
    "fast": ["codex-5.3-high", "gemini-3-flash"],
    "opus-swarm": ["claude-opus", "claude-opus", "claude-opus"]
  }
}
```

### Running the same tool multiple times

If you want multiple independent responses from the same configured tool, just repeat it in `--tools` (or inside a group). Counselors will automatically fan it out as separate instances.

```bash
counselors run -t opus,opus,opus "Review this module for edge cases"
```

### Project config

Place a `.counselors.json` in your project root to override `defaults` per-project. Project configs cannot add or modify `tools` (security boundary).

```jsonc
{
  "defaults": {
    "outputDir": "./ai-output",
    "readOnly": "enforced"
  }
}
```

## Read-only modes

| Level | Behavior |
|-------|----------|
| `enforced` | Tool is sandboxed to read-only operations |
| `bestEffort` | Tool is asked to avoid writes but may not guarantee it |
| `none` | Tool has full read/write access |

The `--read-only` flag on `run` controls the policy: `strict` only dispatches to tools with `enforced` support, `best-effort` uses whatever each tool supports, `off` disables read-only flags entirely. When omitted, falls back to the `readOnly` setting in your config defaults (which defaults to `bestEffort`).

## Output structure

Each run creates a directory under your configured output directory (`defaults.outputDir`, default `./agents/counselors`):

```
<outputDir>/{slug}/
  prompt.md              # The dispatched prompt
  run.json               # Manifest with status, timing, costs
  summary.md             # Synthesized summary
  {tool-id}.md           # Each tool's response
  {tool-id}.stderr       # Each tool's stderr
```

If the `{slug}` directory already exists, counselors appends a timestamp suffix to avoid collisions.

For multi-round runs (`loop`), each round gets its own subdirectory:

```
<outputDir>/{slug}/
  round-1/
    prompt.md
    {tool-id}.md
    {tool-id}.stderr
    round-notes.md
  round-2/
    prompt.md              # augmented with prior round outputs
    {tool-id}.md
    round-notes.md
  ...
  final-notes.md           # combined notes across all rounds
  run.json                 # manifest with rounds array
```

## Skill / slash command

Install `/counselors` as a skill in Claude Code or other agents:

```bash
# Print the skill template
counselors skill

# Print full agent setup instructions
counselors agent
```

The skill template provides a multi-phase workflow: gather context, select agents, choose dispatch mode (`run` vs `loop`), assemble prompt/focus, create prompt files via `counselors mkdir` when needed, dispatch, read results, and synthesize a combined answer.

## How is this different from...?

Most parallel-agent tools ([Uzi](https://github.com/devflowinc/uzi), [FleetCode](https://github.com/built-by-as/FleetCode), [AI Fleet](https://github.com/nachoal/ai-fleet), [Superset](https://superset.sh)) are designed to parallelize _different tasks_ — each agent gets its own git worktree and works on a separate problem. They're throughput tools.

Counselors does something different: it sends the _same prompt_ to multiple agents and collects their independent perspectives. It's a "council of advisors" pattern — you're not splitting work, you're getting second opinions.

Other differences:

- **No git worktrees, no containers, no infrastructure.** Counselors just calls your locally installed CLIs and writes markdown files.
- **Read-only by default.** Agents are sandboxed to read-only mode so they can review your code without modifying it.
- **Built for agentic use.** The slash-command workflow lets your primary agent orchestrate the whole process — gather context, fan out, and synthesize — without you leaving your editor.

## Examples

The real value shows up when models disagree. Here are cross-model disagreement tables from actual counselors runs, synthesized by the primary agent:

**Topic: Tauri close-request handling** — _Claude Opus, Gemini Pro, Codex_

> /counselors Review my plan for handling Tauri 2.x close-request events — is the CloseRequested API usage correct, are there known emit_to bugs, and should "Stop All" be per-window or global?

| Topic | Claude Opus | Gemini Pro | Codex |
|-------|-------------|------------|-------|
| CloseRequested API | Says `set_prevent_default(true)` is correct for Tauri 2.x | Agrees plan is correct | Says plan is wrong — claims `api.prevent_close()` is needed |
| `emit_to` reliability | Flags potential Tauri bug (#10182) where `emit_to` may broadcast anyway; wants fallback plan | Says raw `app.emit_to` may be needed if tauri-specta doesn't expose it | Says `emit_to` is correct |
| "Stop All" semantics | Says keep it global (app-level menu = all processes) | No comment | Says command palette "stop all" is not ownership-aware |

---

**Topic: Escape key / modal stacking** — _Codex, Gemini, Amp_

> /counselors How should I implement escape-to-dismiss for stacked modals? Currently openModals is a Set and Escape closes everything. I want it to dismiss only the topmost modal.

| Approach | Codex | Gemini | Amp |
|----------|-------|--------|-----|
| Stack location | Parallel `modalStack: string[]` alongside `openModals: Set` | Replace `openModals: Set` → `openModals: string[]` | Separate `escapeStack` + `escapeHandlers` alongside `openModals: Set` |
| ESC dispatch | Each Modal keeps its own window listener but no-ops if not topmost | Same as Codex | One global dispatcher + handler registry; Modals don't add window listeners at all |
| Complexity | Medium (add stack, check in Modal) | Low (swap Set→Array, check in Modal) | Higher (new escape stack, new hooks, new global dispatcher, store handler functions) |

---

**Topic: Terminal drag-and-drop / image paste** — _Claude Opus, Gemini Pro, Codex_

> /counselors What's the best approach for drag-and-drop files and image paste in my ghostty-web terminal? Is inline image rendering feasible on the Canvas/WASM renderer or should I just insert file paths?

All 3 agents agreed on these key points:

1. Drag-and-drop should insert shell-escaped file paths — this is the universal convention (Terminal.app, iTerm2, Kitty, Ghostty native all do it). Highest value, lowest effort. Do it first.
2. Image paste should save to a temp file and insert the path — no terminal pastes raw image data. Show a toast to explain what happened.
3. Do NOT build inline image rendering now — ghostty-web's Canvas renderer has no image rendering capability. Building an HTML overlay compositor would be 40-80 hours of work for low value in a dev tool.
4. ghostty-web does NOT support image display despite native Ghostty supporting Kitty Graphics Protocol. The web/WASM build lacks the Metal/OpenGL rendering paths needed.

| Topic | Claude Opus | Gemini Pro |
|-------|-------------|------------|
| Kitty rendering | "ghostty-web does NOT render images" | Suggests "rely on ghostty-web's built-in Kitty support" |

The synthesizing agent's assessment: Claude Opus and Codex are correct — ghostty-web's CanvasRenderer draws text cells only. Gemini appears to conflate native Ghostty (which does support Kitty graphics) with ghostty-web (which doesn't have rendering paths for it).

---

**Topic: Rust detection module refactor** — _Claude, Gemini, Codex_

> /counselors The detection module is ~1200 lines in one file with boolean fields on DetectionContext. How should I refactor it — module directory, lazy file checks, rule engine? Also check for bugs in dedup and orchestration-skip logic.

All 3 agents agreed:

1. Split into `detection/` module directory — 1200-line file is the most immediate problem
2. Replace `DetectionContext` boolean fields with a lazy/cached `file_exists()`
3. The Laravel pattern (`LaravelPackages` sub-struct) is superior to Node.js's inline booleans
4. Don't build a full rule engine/DSL — conditional logic varies too much

Codex also found 2 bugs all agents acknowledged: dedup by name drops valid suggestions in polyglot repos, and Procfile orchestration skip is too broad.

---

**Topic: ghostty-web 0.3.0 to 0.4.0 upgrade** — _Claude, Codex, Gemini_

> /counselors Review my ghostty-web 0.3.0 → 0.4.0 upgrade plan. Key concerns: getLine() WASM bug, DSR response handling, isComposing guard for CJK, phase ordering, and renderer.metrics hack risk.

| Question | Consensus |
|----------|-----------|
| `getLine()` bug fixed? | All agree: likely fixed — old broken WASM export completely removed |
| DSR response coordination | All agree: strip CPR/DA from backend, keep kitty-only |
| `patchInputHandler` | All agree: must add `isComposing` guard — CJK/IME will break without it |
| Phase ordering | All agree: keep phases 4 and 5 separate, add a Phase 0 for compat checker |
| `renderer.metrics` hack | All agree: high to extremely high risk of breakage in 0.4.0 |

**Topic: Multi-round test gap hunting** — _`loop --preset test`_

> counselors loop --preset test --scope src/auth/ --rounds 3

Round 1 discovers the test landscape and finds initial gaps. Round 2 reads the round-1 reports and hunts for edge cases the first round missed. Round 3 goes deeper on anything still uncovered. Each agent independently builds on prior findings without repeating them.

## Security

- **Environment allowlisting**: Child processes only receive allowlisted environment variables (PATH, HOME, API keys, proxy settings, etc.) — no full `process.env` leak.
- **Atomic config writes**: Config files are written atomically via temp+rename with `0o600` permissions.
- **Tool name validation**: Tool IDs are validated against `[a-zA-Z0-9._-]` to prevent path traversal.
- **No shell execution**: All child processes use `execFile`/`spawn` without `shell: true`.
- **Project config isolation**: `.counselors.json` can only override `defaults`, never inject `tools`.

## Development

```bash
npm install
npm run build        # tsup → dist/cli.js
npm run test         # vitest (unit + integration)
npm run typecheck    # tsc --noEmit
npm run lint         # biome check
```

Requires Node 20+. TypeScript with ESM, built with tsup, tested with vitest, linted with biome.

## Known issues

- **Amp `deep` model uses Bash to read files.** The `deep` model (GPT-5.2 Codex) reads files via `Bash` rather than the `Read` tool. Because `Bash` is a write-capable tool, we cannot guarantee that deep mode will not modify files. A mandatory read-only instruction is injected into the prompt, but this is a best-effort safeguard. For safety-critical tasks, prefer `amp-smart`.
- **Antigravity read-only enforcement depends on shared, external state.** Unlike the other adapters, `agy` has no per-invocation flag to grant read-only access — enforcement comes from a `permissions.allow: ["read_file(*)"]` rule in the user's real, shared `~/.gemini/antigravity-cli/settings.json`, the same file their regular interactive Antigravity usage writes to. If that file ever also carries a write-capable rule (from normal interactive use), the adapter detects it and downgrades to `bestEffort` rather than silently claiming `enforced`.

## License

MIT
