#!/usr/bin/env npx tsx
/**
 * v1_basic_agent.ts — Basic Agent with 4 Core Tools (~250 lines)
 *
 * Core insight: The model IS the agent — give it tools and it decides
 * what to do. Four tools cover 90% of coding tasks:
 *   Bash, Read, Write, Edit
 *
 * This version mirrors Claude Code's fundamental tool set.
 */

import Anthropic from "@anthropic-ai/sdk";
import { execSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname } from "path";
import * as readline from "readline";

const client = new Anthropic();

// ── Tool Definitions ──────────────────────────────────────────────

const tools: Anthropic.Tool[] = [
  {
    name: "Bash",
    description:
      "Run a shell command. Use for git, npm, tests, searches, and any system operation.",
    input_schema: {
      type: "object" as const,
      properties: {
        command: { type: "string", description: "The bash command to run" },
      },
      required: ["command"],
    },
  },
  {
    name: "Read",
    description:
      "Read a file from disk. Returns contents with line numbers. Supports offset/limit for large files.",
    input_schema: {
      type: "object" as const,
      properties: {
        file_path: { type: "string", description: "Absolute path to the file" },
        offset: {
          type: "number",
          description: "Start line (1-indexed). Omit to read from start.",
        },
        limit: {
          type: "number",
          description: "Max lines to read. Omit to read entire file.",
        },
      },
      required: ["file_path"],
    },
  },
  {
    name: "Write",
    description:
      "Write content to a file. Creates parent directories if needed. Overwrites existing files.",
    input_schema: {
      type: "object" as const,
      properties: {
        file_path: { type: "string", description: "Absolute path to the file" },
        content: { type: "string", description: "The full file content to write" },
      },
      required: ["file_path", "content"],
    },
  },
  {
    name: "Edit",
    description:
      "Replace a specific string in a file. The old_string must match exactly (including whitespace).",
    input_schema: {
      type: "object" as const,
      properties: {
        file_path: { type: "string", description: "Absolute path to the file" },
        old_string: { type: "string", description: "Exact text to find and replace" },
        new_string: { type: "string", description: "Replacement text" },
      },
      required: ["file_path", "old_string", "new_string"],
    },
  },
];

// ── Tool Implementations ──────────────────────────────────────────

function executeBash(command: string): string {
  try {
    return execSync(command, {
      encoding: "utf-8",
      timeout: 30000,
      cwd: process.cwd(),
    }).slice(0, 15000);
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return [err.stdout, err.stderr, err.message].filter(Boolean).join("\n").slice(0, 15000);
  }
}

function readFile(
  filePath: string,
  offset?: number,
  limit?: number
): string {
  try {
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    const start = (offset ?? 1) - 1;
    const end = limit ? start + limit : lines.length;
    return lines
      .slice(start, end)
      .map((line, i) => `${String(start + i + 1).padStart(6)}|${line}`)
      .join("\n");
  } catch (e: unknown) {
    return `Error: ${(e as Error).message}`;
  }
}

function writeFile(filePath: string, content: string): string {
  try {
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, content, "utf-8");
    return `File written successfully to ${filePath}`;
  } catch (e: unknown) {
    return `Error: ${(e as Error).message}`;
  }
}

function editFile(
  filePath: string,
  oldString: string,
  newString: string
): string {
  try {
    const content = readFileSync(filePath, "utf-8");
    const count = content.split(oldString).length - 1;
    if (count === 0) return `Error: old_string not found in ${filePath}`;
    if (count > 1) return `Error: old_string found ${count} times — must be unique`;
    writeFileSync(filePath, content.replace(oldString, newString), "utf-8");
    return `Successfully edited ${filePath}`;
  } catch (e: unknown) {
    return `Error: ${(e as Error).message}`;
  }
}

function executeTool(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "Bash":
      return executeBash(input.command as string);
    case "Read":
      return readFile(
        input.file_path as string,
        input.offset as number | undefined,
        input.limit as number | undefined
      );
    case "Write":
      return writeFile(input.file_path as string, input.content as string);
    case "Edit":
      return editFile(
        input.file_path as string,
        input.old_string as string,
        input.new_string as string
      );
    default:
      return `Unknown tool: ${name}`;
  }
}

// ── Agent Loop ────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a powerful coding assistant. You have access to tools for reading, writing, editing files, and running shell commands. Use them to help the user accomplish their tasks.

Important rules:
- Always read a file before editing it
- Use Edit for surgical changes, Write for creating new files
- Prefer Edit over Write when modifying existing files
- Be concise in your responses`;

async function agentLoop(
  messages: Anthropic.MessageParam[]
): Promise<string> {
  while (true) {
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      tools,
      messages,
    });

    const textParts = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text);

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );

    if (textParts.length > 0) {
      for (const text of textParts) process.stdout.write(text);
    }

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
      return textParts.join("\n");
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = toolUses.map(
      (tool) => {
        const input = tool.input as Record<string, unknown>;
        console.log(`\n\x1b[36m[${tool.name}]\x1b[0m`, formatToolInput(tool.name, input));
        const output = executeTool(tool.name, input);
        const preview = output.slice(0, 300);
        if (preview.trim()) console.log(`\x1b[90m${preview}${output.length > 300 ? "..." : ""}\x1b[0m`);
        return { type: "tool_result" as const, tool_use_id: tool.id, content: output };
      }
    );
    messages.push({ role: "user", content: toolResults });
  }
}

function formatToolInput(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "Bash":
      return `$ ${input.command}`;
    case "Read":
      return `${input.file_path}${input.offset ? ` (lines ${input.offset}-${(input.offset as number) + ((input.limit as number) || 0)})` : ""}`;
    case "Write":
      return `${input.file_path} (${(input.content as string).split("\n").length} lines)`;
    case "Edit":
      return `${input.file_path}`;
    default:
      return JSON.stringify(input);
  }
}

// ── REPL ──────────────────────────────────────────────────────────

async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  console.log("minicc v1 — Basic Agent (Bash/Read/Write/Edit)");
  console.log("Type 'exit' to quit\n");

  const messages: Anthropic.MessageParam[] = [];

  const ask = () =>
    rl.question("> ", async (input) => {
      if (input.trim().toLowerCase() === "exit") return rl.close();
      if (!input.trim()) return ask();
      messages.push({ role: "user", content: input });
      try {
        await agentLoop(messages);
        console.log();
      } catch (e: unknown) {
        console.error("\x1b[31mError:\x1b[0m", (e as Error).message);
      }
      ask();
    });
  ask();
}

main();
