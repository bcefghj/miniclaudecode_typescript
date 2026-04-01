#!/usr/bin/env npx tsx
/**
 * s01 — The Agent Loop (~100 lines)
 *
 * "One loop & Bash is all you need."
 *
 * The minimal agent kernel: a while loop + one tool.
 * Everything else in this course layers on top — without changing the loop.
 *
 * SOURCE MAPPING (Claude Code 原版对照):
 *   query.ts:queryLoop (~1730 lines) → distilled to ~20 lines here
 *   The core pattern is identical: call model → check stop_reason → execute tools → loop
 */

import Anthropic from "@anthropic-ai/sdk";
import { execSync } from "child_process";
import * as readline from "readline";

const client = new Anthropic();
const MODEL = process.env.MINICC_MODEL || "claude-sonnet-4-20250514";

// One tool is enough to be useful
const TOOLS: Anthropic.Tool[] = [
  {
    name: "Bash",
    description: "Run a shell command and return stdout/stderr.",
    input_schema: {
      type: "object" as const,
      properties: {
        command: { type: "string", description: "The bash command to execute" },
      },
      required: ["command"],
    },
  },
];

function runBash(command: string): string {
  try {
    return execSync(command, {
      encoding: "utf-8",
      timeout: 30_000,
      cwd: process.cwd(),
    }).slice(0, 10_000);
  } catch (e: unknown) {
    const err = e as { stderr?: string; message?: string };
    return `Error: ${err.stderr || err.message}`;
  }
}

/**
 * The entire agent in one function.
 * This is the pattern that powers Claude Code's 500K+ line codebase.
 */
async function agentLoop(query: string) {
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: query },
  ];

  while (true) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: "You are a coding assistant. Use the Bash tool to help the user.",
      tools: TOOLS,
      messages,
    });

    messages.push({ role: "assistant", content: response.content });

    // Exit condition: model didn't call a tool → we're done
    if (response.stop_reason !== "tool_use") {
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      console.log(text);
      return;
    }

    // Execute each tool call, collect results, loop back
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        const { command } = block.input as { command: string };
        console.log(`\x1b[90m$ ${command}\x1b[0m`);
        const output = runBash(command);
        if (output.trim()) console.log(output.slice(0, 500));
        results.push({ type: "tool_result", tool_use_id: block.id, content: output });
      }
    }
    messages.push({ role: "user", content: results });
  }
}

// --- REPL ---
async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log("minicc s01 — Agent Loop (one loop & Bash is all you need)");
  const ask = () =>
    rl.question("\n> ", async (input) => {
      if (input.trim().toLowerCase() === "exit") return rl.close();
      try { await agentLoop(input); } catch (e: unknown) { console.error((e as Error).message); }
      ask();
    });
  ask();
}
main();
