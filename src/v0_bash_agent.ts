#!/usr/bin/env npx tsx
/**
 * v0_bash_agent.ts — The Minimal Agent (~80 lines)
 *
 * Core insight: An AI agent is just a loop —
 *   prompt → model → tool_use? → execute → repeat
 *
 * This version has exactly ONE tool (Bash) and demonstrates
 * the fundamental agent loop that powers Claude Code.
 */

import Anthropic from "@anthropic-ai/sdk";
import { execSync } from "child_process";
import * as readline from "readline";

const client = new Anthropic();

const BASH_TOOL: Anthropic.Tool = {
  name: "Bash",
  description:
    "Run a shell command and return its output. Use this for any system operation.",
  input_schema: {
    type: "object" as const,
    properties: {
      command: {
        type: "string",
        description: "The bash command to execute",
      },
    },
    required: ["command"],
  },
};

function executeBash(command: string): string {
  try {
    return execSync(command, {
      encoding: "utf-8",
      timeout: 30000,
      cwd: process.cwd(),
    }).slice(0, 10000);
  } catch (e: unknown) {
    const err = e as { stderr?: string; message?: string };
    return `Error: ${err.stderr || err.message}`;
  }
}

async function agentLoop(
  messages: Anthropic.MessageParam[]
): Promise<string> {
  while (true) {
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system:
        "You are a coding assistant. Use the Bash tool to help the user. Be concise.",
      tools: [BASH_TOOL],
      messages,
    });

    // Collect assistant text
    const textParts = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text);

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
      return textParts.join("\n");
    }

    // Execute each tool call and feed results back
    const toolResults: Anthropic.ToolResultBlockParam[] = toolUses.map(
      (tool) => {
        const input = tool.input as { command: string };
        console.log(`\x1b[90m$ ${input.command}\x1b[0m`);
        const output = executeBash(input.command);
        if (output.trim()) console.log(output.slice(0, 500));
        return { type: "tool_result" as const, tool_use_id: tool.id, content: output };
      }
    );
    messages.push({ role: "user", content: toolResults });
  }
}

async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  console.log("minicc v0 — Bash Agent (type 'exit' to quit)");

  const ask = () =>
    rl.question("\n> ", async (input) => {
      if (input.trim().toLowerCase() === "exit") return rl.close();
      try {
        const reply = await agentLoop([{ role: "user", content: input }]);
        console.log(`\n${reply}`);
      } catch (e: unknown) {
        console.error("Error:", (e as Error).message);
      }
      ask();
    });
  ask();
}

main();
