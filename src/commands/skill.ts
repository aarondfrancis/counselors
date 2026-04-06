import type { Command } from 'commander';
import { info } from '../ui/logger.js';

export function registerSkillCommand(program: Command): void {
  program
    .command('skill')
    .description('Print a skill/slash-command template for coding agents')
    .action(async () => {
      const template = `---
name: counselors
description: Get parallel second opinions from multiple AI coding agents. Use when the user wants independent reviews, architecture feedback, or a sanity check from other AI models.
---

# Counselors — Multi-Agent Review Skill

> **⏱ Long-running command.** Counselors dispatches to multiple external AI agents in parallel, each of which may take several minutes. Total wall time is commonly **10–20+ minutes**. Consider running the dispatch command (Phase 5) in the background and monitoring progress rather than blocking your main context. You can check on results periodically and proceed to Phase 6 once the process completes. Counselors is a well-behaved long-running process: it emits periodic heartbeat lines to stdout and prints each child process PID alongside the agent name, so you can verify agents are still running.

> **Note:** This is a reference skill template. Your agent system may use a different skill/command format. Adapt the structure and frontmatter below to match your system's conventions — the workflow and phases are what matter.

Fan out a prompt to multiple AI coding agents in parallel and synthesize their responses.

Use \`run\` for single-shot parallel review, or \`loop\` for iterative multi-round analysis.

Arguments: $ARGUMENTS

**If no arguments provided**, ask the user what they want reviewed.

---

## Phase 1: Context Gathering

Parse \`$ARGUMENTS\` to understand what the user wants reviewed. Then identify relevant context:

1. **Files mentioned in the prompt**: Use Glob/Grep to find files referenced by name, class, function, or keyword
2. **Recent changes**: Run \`git diff HEAD\` and \`git diff --staged\` to identify what changed
3. **Related code**: Search for key terms from the prompt to identify the most relevant files (up to 5 files)

**Important**: You do NOT need to read and inline every file. Subagents have access to the filesystem and git — they can read files and run git commands themselves. Your job is to *identify* the relevant files and reference them, not to copy their contents into the prompt. See Phase 4 for how to use \`@file\` references.

---

## Phase 2: Dispatch Mode Selection

Decide whether this request should use \`run\` or \`loop\`.

1. **Default to \`run\`** for a quick second-opinion pass.
2. **Use \`loop\`** when the user wants deeper iterative analysis, broad hunts, or multi-round convergence.
3. If using \`loop\`, choose one of two loop modes:
   - **Preset loop**: use \`--preset\` for domain workflows (bug, security, state, regression, API contracts, performance)
   - **Custom loop**: no preset; you write a full prompt file just like \`run\`, but dispatch with \`counselors loop\`
   - **Inline loop**: pass a short prompt string directly (no \`-f\`); counselors automatically runs discovery + prompt-writing phases to expand it into a full execution prompt. Use \`--no-inline-enhancement\` to skip this and send the raw prompt as-is.

If the user says "use a preset" or names one, run:
\`\`\`bash
counselors loop --list-presets
\`\`\`
Print the output and have them pick a preset.

---

## Phase 3: Agent Selection

1. **Discover available agents and groups** by running via Bash:
   \`\`\`bash
   counselors ls
   counselors groups ls
   \`\`\`
   The first command lists all configured agents with their IDs and binaries. The second lists any configured **groups** (predefined sets of tool IDs).

2. **MANDATORY: Print the full agent list and group list, then ask the user which to use.**

   **Always print the full \`counselors ls\` output and \`counselors groups ls\` output as inline text** (not inside AskUserQuestion). Just show the raw output so the user sees every tool/group. Do NOT reformat or abbreviate it.

   Then ask the user to pick:

   **If 4 or fewer agents**: Use AskUserQuestion with \`multiSelect: true\`, one option per agent.

   **If more than 4 agents**: AskUserQuestion only supports 4 options. Use these fixed options:
   - Option 1: "All [N] agents" — sends to every configured agent
	   - Option 2-4: The first 3 individual agents by ID
	   - The user can always select "Other" to type a comma-separated list of agent IDs from the printed list above

	   If groups exist, you MAY offer group options (e.g. "Group: smart"), but you MUST expand them to the underlying tool IDs and confirm that expanded list with the user before dispatch. This avoids silently omitting or adding agents.
	   If the user says something like "use the smart group", you MUST look up that group in the configured groups list (\`counselors groups ls\`). If it exists, use it (via \`--group smart\` or by expanding to tool IDs) and confirm the expanded tool list before dispatch. If it does not exist, tell the user and ask them to choose again — do not guess.

	3. Wait for the user's selection before proceeding.

4. **MANDATORY: Confirm the selection before continuing.** After the user picks agents, echo back the exact list you will dispatch to:

   > Dispatching to: **claude-opus**, **codex-5.3-high**, **gemini-pro**

   Then ask the user to confirm (e.g. "Look good?") before proceeding to Phase 4. This prevents silent tool omissions. If the user corrects the list, update your selection accordingly.

5. **Discovery tool (loop only)**: By default, the first tool in your selection runs the discovery and prompt-writing prep phases. To use a different agent for these phases, pass \`--discovery-tool <id>\`.

---

## Phase 4: Prompt Assembly

For \`run\` and custom \`loop\` (file-based) modes, assemble the review prompt content.
For preset loop mode and inline loop mode, skip this phase — counselors handles prompt generation automatically via discovery + prompt-writing phases (see Phase 5).

**Note:** Counselors automatically appends execution boilerplate (general guidelines about focusing on source dirs, skipping vendor/binary files, providing file paths for findings) to every prompt before dispatch. You do not need to include these instructions yourself.

   **Subagents can read files and use git.** You do NOT need to inline file contents or diff output into the prompt. Instead, use \`@path/to/file\` references to point subagents at the relevant files. They will read the files themselves. This keeps the prompt concise and avoids bloating it with copied code.

   Only inline small, critical snippets if they're essential for framing the question (e.g. a specific function signature or error message). For everything else, use \`@file\` references.

\`\`\`markdown
# Review Request

## Question
[User's original prompt/question from $ARGUMENTS]

## Context

### Files to Review
[List @path/to/file references for each relevant file found in Phase 1]
[e.g. @src/core/executor.ts, @src/adapters/claude.ts]

### Recent Changes
[Brief description of what changed. If a diff is relevant, tell the agent to run \`git diff HEAD\` themselves, or inline only a small critical snippet]

### Related Code
[@path/to/file references for related files discovered via search]

## Instructions
You are providing an independent review. Be critical and thorough.
- Read the referenced files to understand the full context
- Analyze the question in the context provided
- Identify risks, tradeoffs, and blind spots
- Suggest alternatives if you see better approaches
- Be direct and opinionated — don't hedge
- Structure your response with clear headings
\`\`\`

---

## Phase 5: Dispatch

Dispatch based on the selected mode.

### Mode A: \`run\` (single-shot)

First, create the output directory + \`prompt.md\` via counselors itself by piping your assembled prompt content:

\`\`\`bash
cat <<'PROMPT' | counselors mkdir --json
[assembled prompt content from Phase 4]
PROMPT
\`\`\`

Parse the JSON output and read \`promptFilePath\`, then dispatch with that path:

\`\`\`bash
counselors run -f <promptFilePath> --tools [comma-separated-tool-ids] --json
\`\`\`

Examples:
- \`--tools claude,codex,gemini\`
- \`--group smart\` (uses the configured group)
- \`--group smart --tools codex\` (group plus explicit tools)

### Mode B: \`loop\` + custom prompt file (iterative, no preset)

As with Mode A, first create \`prompt.md\` via \`counselors mkdir --json\`, then run:

\`\`\`bash
counselors loop -f <promptFilePath> --tools [comma-separated-tool-ids] --json
\`\`\`

Using \`-f\` skips the discovery/prompt-writing phases and sends the prompt as-is. You may add these optional flags:
- \`--rounds <N>\` — number of rounds (default: 3)
- \`--duration <time>\` — max wall time (e.g. \`30m\`, \`1h\`); when set without explicit \`--rounds\`, rounds are unlimited
- \`--convergence-threshold <ratio>\` — early stop when output word count drops below this ratio of the previous round (default: 0.3)

### Mode C: \`loop\` + inline prompt (iterative, no preset, auto-enhanced)

Pass a short prompt string directly. Counselors automatically runs two prep phases before dispatch:
1. **Discovery** — the discovery tool scans the repo to gather structural context
2. **Prompt writing** — the discovery tool expands your short input into a full execution prompt grounded in the discovered context

\`\`\`bash
counselors loop "find race conditions in the worker pool" --tools [comma-separated-tool-ids] --json
\`\`\`

To skip the automatic enhancement and send the raw prompt: add \`--no-inline-enhancement\`.

### Mode D: \`loop\` + preset (iterative, preset-driven)

For preset mode, do NOT write a full prompt file. Pass a concise focus string instead. The preset provides domain-specific instructions, and counselors runs the same discovery + prompt-writing phases as inline mode.

\`\`\`bash
counselors loop --preset <preset-name> "<focus area>" --tools [comma-separated-tool-ids] --json
\`\`\`

Example:
- \`counselors loop --preset hotspots "critical request path" --group smart --duration 20m --json\`

### Loop behavior: prior-round enrichment

In rounds 2+, counselors automatically augments the prompt with \`@file\` references to all prior round outputs. Agents receive explicit instructions to:
- Not repeat findings unless adding new evidence
- Challenge and refine prior claims
- Follow adjacent code paths discovered in earlier rounds
- Label overlapping findings as confirmed, refined, invalidated, or duplicate

### Common flags for all loop modes

| Flag | Description |
|------|-------------|
| \`--rounds <N>\` | Number of rounds (default: 3) |
| \`--duration <time>\` | Max wall time (\`30m\`, \`1h\`); unlimited rounds when set alone |
| \`--convergence-threshold <ratio>\` | Early stop ratio (default: 0.3) |
| \`--discovery-tool <id>\` | Agent for prep phases (default: first tool) |
| \`--no-inline-enhancement\` | Skip discovery/prompt-writing for inline prompts |

Use \`timeout: 600000\` (10 minutes) or higher. Counselors dispatches to the selected agents in parallel and writes results to the output directory shown in the JSON output.

**Important**: For run/custom-loop file mode, use \`-f\` so the prompt is sent as-is without wrapping. Use \`--json\` on both \`mkdir\` and dispatch commands to get structured output for parsing.

**Timing**: Sessions commonly take more than 10 minutes. Counselors prints each child process PID alongside the agent name in its progress output (e.g. \`PID 12345  claude\`). If a run seems stuck, you can verify processes are still alive with \`ps -p <PID>\` (macOS/Linux) or \`tasklist /FI "PID eq <PID>"\` (Windows).

---

## Phase 6: Read Results

1. **Parse the JSON output** from stdout — it contains the run manifest with status, duration, word count, and output file paths for each agent
2. **Read each agent's response** from the \`outputFile\` path in the manifest
3. **Check \`stderrFile\` paths** for any agent that failed or returned empty output
4. **Skip empty or error-only reports** — note which agents failed

### Loop output structure

For \`loop\` runs, the output directory contains per-round subdirectories plus cross-round notes:

\`\`\`
{outputDir}/
├── round-1/
│   ├── prompt.md          # Input prompt for this round
│   ├── {tool-id}.md       # Each agent's output
│   └── round-notes.md     # Per-round summary (auto-generated)
├── round-2/
│   ├── prompt.md          # Base prompt + @file refs to round-1 outputs
│   ├── {tool-id}.md
│   └── round-notes.md
├── final-notes.md         # Cross-round summary (auto-generated)
└── run.json               # Structured manifest with all rounds
\`\`\`

The manifest's \`rounds\` array contains per-round tool reports. \`totalRounds\` and \`durationMs\` are at the top level. Start with \`final-notes.md\` for a high-level summary, then drill into individual round outputs as needed.

---

## Phase 7: Synthesize and Present

Combine all agent responses into a synthesis:

\`\`\`markdown
## Counselors Review

**Agents consulted:** [list of agents that responded]

**Consensus:** [What most agents agree on — key takeaways]

**Disagreements:** [Where they differ, and reasoning behind each position]

**Key Risks:** [Risks or concerns flagged by any agent]

**Blind Spots:** [Things none of the agents addressed that seem important]

**Recommendation:** [Your synthesized recommendation based on all inputs]

---
Reports saved to: [output directory from manifest]
\`\`\`

Present this synthesis to the user. Be concise — the individual reports are saved for deep reading.

---

## Phase 8: Action (Optional)

After presenting the synthesis, ask the user what they'd like to address. Offer the top 2-3 actionable items from the synthesis as options. If the user wants to act on findings, plan the implementation before making changes.

---

## Error Handling

- **counselors not installed**: Tell the user to install it (\`npm install -g counselors\`)
- **No tools configured**: Tell the user to run \`counselors init\` or \`counselors tools add <tool>\`
- **Agent fails**: Note it in the synthesis and continue with other agents' results
- **All agents fail**: Report errors from stderr files and suggest checking \`counselors doctor\`
`;

      info(template);
    });
}
