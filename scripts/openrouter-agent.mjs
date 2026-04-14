#!/usr/bin/env node
// openrouter-agent — cross-platform Node.js wrapper for OpenRouter API
//
// Reads a prompt from stdin, sends it to OpenRouter's API, and prints the response.
// Use this with counselors' custom adapter to access 200+ models via a single API key.
//
// Usage:
//   echo "prompt" | openrouter-agent --model anthropic/claude-sonnet-4
//   echo "prompt" | openrouter-agent --model openai/gpt-5.4 --reasoning-effort medium --max-tokens 32000
//
// Flags:
//   --model <id>             (required) OpenRouter model id (e.g. anthropic/claude-opus-4.6)
//   --reasoning-effort <low|medium|high>  optional, forwarded to OpenRouter reasoning param
//   --max-tokens <n>         optional, default 32000 (override with OPENROUTER_AGENT_MAX_TOKENS env)
//
// Requires:
//   - OPENROUTER_API_KEY in environment (get one at https://openrouter.ai/keys)
//   - Node.js 20+ (uses built-in fetch)

// Parse flags from argv. Supports both --flag value and --flag=value.
let model = '';
let reasoningEffort = '';
let maxTokens = Number(process.env.OPENROUTER_AGENT_MAX_TOKENS) || 32000;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--model' && args[i + 1]) { model = args[i + 1]; i++; }
  else if (a.startsWith('--model=')) { model = a.slice('--model='.length); }
  else if (a === '--reasoning-effort' && args[i + 1]) { reasoningEffort = args[i + 1]; i++; }
  else if (a.startsWith('--reasoning-effort=')) { reasoningEffort = a.slice('--reasoning-effort='.length); }
  else if (a === '--max-tokens' && args[i + 1]) { maxTokens = Number(args[i + 1]); i++; }
  else if (a.startsWith('--max-tokens=')) { maxTokens = Number(a.slice('--max-tokens='.length)); }
}

if (!model) {
  process.stderr.write('Error: --model is required\n');
  process.exit(1);
}

if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
  process.stderr.write('Error: --max-tokens must be a positive integer\n');
  process.exit(1);
}

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  process.stderr.write('Error: OPENROUTER_API_KEY not set\n');
  process.exit(1);
}

// Read full prompt from stdin (pipe mode — works cross-platform, no readline)
async function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

async function main() {
  const prompt = await readStdin();

  if (!prompt.trim()) {
    process.stderr.write('Error: no prompt received on stdin\n');
    process.exit(1);
  }

  const requestBody = {
    model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: maxTokens,
  };
  if (reasoningEffort) {
    requestBody.reasoning = { effort: reasoningEffort };
  }

  let response;
  try {
    response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'counselors',
      },
      body: JSON.stringify(requestBody),
    });
  } catch (err) {
    process.stderr.write(`Error: fetch failed — ${err.message}\n`);
    process.exit(1);
  }

  let body;
  try {
    body = await response.json();
  } catch (err) {
    process.stderr.write(`Error: failed to parse response JSON — ${err.message}\n`);
    process.exit(1);
  }

  if (!response.ok) {
    process.stderr.write(`Error: OpenRouter returned HTTP ${response.status}\n`);
    process.stderr.write(JSON.stringify(body, null, 2) + '\n');
    process.exit(1);
  }

  // OpenRouter can return HTTP 200 with a top-level "error" field when the upstream
  // provider returns a structured error. Surface that explicitly.
  if (body?.error) {
    process.stderr.write(`Error: OpenRouter returned error in body: ${JSON.stringify(body.error)}\n`);
    process.exit(1);
  }

  const choices = body?.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    process.stderr.write('Error: no choices in response\n');
    process.stderr.write(JSON.stringify(body, null, 2) + '\n');
    process.exit(1);
  }

  const choice = choices[0];
  const content = choice?.message?.content;

  // Treat null, non-string, or whitespace-only content as a failure. This surfaces
  // the real cause (usually finish_reason=length from reasoning-token blowout) instead
  // of printing the literal string "None" or "" and reporting success.
  if (typeof content !== 'string' || content.trim() === '') {
    const finish = choice?.finish_reason ?? choice?.native_finish_reason ?? 'unknown';
    const usage = body?.usage ?? {};
    const reasoningTokens = usage?.completion_tokens_details?.reasoning_tokens;
    process.stderr.write(
      `Error: empty content from OpenRouter. ` +
      `finish_reason=${finish} ` +
      `completion_tokens=${usage.completion_tokens ?? 'n/a'} ` +
      `reasoning_tokens=${reasoningTokens ?? 'n/a'} ` +
      `total_tokens=${usage.total_tokens ?? 'n/a'}\n`,
    );
    if (finish === 'length') {
      process.stderr.write(
        'Hint: hit max_tokens. Increase --max-tokens or reduce --reasoning-effort.\n',
      );
    }
    process.exit(1);
  }

  process.stdout.write(content + '\n');
}

main().catch((err) => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(1);
});
