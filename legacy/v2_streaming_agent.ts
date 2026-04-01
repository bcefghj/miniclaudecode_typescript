#!/usr/bin/env npx tsx
/**
 * v2_streaming_agent.ts — Streaming Agent with Token Tracking (~400 lines)
 *
 * Core insight: Streaming makes the agent feel alive — text appears
 * character by character, and we can start executing tools before
 * the model finishes generating all tool calls.
 *
 * New in v2:
 *   - Streaming API responses (real-time text output)
 *   - Token usage tracking & cost estimation
 *   - Glob & Grep tools (search the codebase)
 *   - Colored terminal output
 */

import Anthropic from "@anthropic-ai/sdk";
import { execSync } from "child_process";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  statSync,
} from "fs";
import { dirname, join, relative } from "path";
import * as readline from "readline";

const client = new Anthropic();

// ── Color helpers ─────────────────────────────────────────────────

const c = {
  reset: "\x1b[0m",
  dim: "\x1b[90m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  bold: "\x1b[1m",
};

// ── Tool Definitions ──────────────────────────────────────────────

const tools: Anthropic.Tool[] = [
  {
    name: "Bash",
    description: "Run a shell command and return stdout/stderr.",
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
    description: "Read a file with line numbers. Use offset/limit for large files.",
    input_schema: {
      type: "object" as const,
      properties: {
        file_path: { type: "string" },
        offset: { type: "number", description: "Start line (1-indexed)" },
        limit: { type: "number", description: "Max lines to read" },
      },
      required: ["file_path"],
    },
  },
  {
    name: "Write",
    description: "Write full content to a file. Creates directories as needed.",
    input_schema: {
      type: "object" as const,
      properties: {
        file_path: { type: "string" },
        content: { type: "string", description: "Complete file content" },
      },
      required: ["file_path", "content"],
    },
  },
  {
    name: "Edit",
    description: "Find and replace a unique string in a file.",
    input_schema: {
      type: "object" as const,
      properties: {
        file_path: { type: "string" },
        old_string: { type: "string", description: "Exact text to find" },
        new_string: { type: "string", description: "Replacement text" },
      },
      required: ["file_path", "old_string", "new_string"],
    },
  },
  {
    name: "Glob",
    description: "Find files matching a glob pattern recursively.",
    input_schema: {
      type: "object" as const,
      properties: {
        pattern: {
          type: "string",
          description: 'Glob pattern, e.g. "**/*.ts"',
        },
        path: {
          type: "string",
          description: "Directory to search in (defaults to cwd)",
        },
      },
      required: ["pattern"],
    },
  },
  {
    name: "Grep",
    description: "Search file contents using a regex pattern (via ripgrep if available, otherwise grep).",
    input_schema: {
      type: "object" as const,
      properties: {
        pattern: { type: "string", description: "Regex pattern to search" },
        path: { type: "string", description: "File or directory to search" },
        include: { type: "string", description: 'File glob filter, e.g. "*.ts"' },
      },
      required: ["pattern"],
    },
  },
];

// ── Tool Implementations ──────────────────────────────────────────

function executeBash(command: string): string {
  try {
    return execSync(command, { encoding: "utf-8", timeout: 30000, cwd: process.cwd() }).slice(0, 15000);
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return [err.stdout, err.stderr, err.message].filter(Boolean).join("\n").slice(0, 15000);
  }
}

function readFile(filePath: string, offset?: number, limit?: number): string {
  try {
    const lines = readFileSync(filePath, "utf-8").split("\n");
    const start = (offset ?? 1) - 1;
    const end = limit ? start + limit : lines.length;
    return lines.slice(start, end).map((l, i) => `${String(start + i + 1).padStart(6)}|${l}`).join("\n");
  } catch (e: unknown) {
    return `Error: ${(e as Error).message}`;
  }
}

function writeFileTool(filePath: string, content: string): string {
  try {
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, content, "utf-8");
    return `File written: ${filePath}`;
  } catch (e: unknown) {
    return `Error: ${(e as Error).message}`;
  }
}

function editFile(filePath: string, oldStr: string, newStr: string): string {
  try {
    const content = readFileSync(filePath, "utf-8");
    const count = content.split(oldStr).length - 1;
    if (count === 0) return `Error: old_string not found in ${filePath}`;
    if (count > 1) return `Error: old_string found ${count} times — must be unique`;
    writeFileSync(filePath, content.replace(oldStr, newStr), "utf-8");
    return `Edited: ${filePath}`;
  } catch (e: unknown) {
    return `Error: ${(e as Error).message}`;
  }
}

function globFiles(pattern: string, searchPath?: string): string {
  const base = searchPath || process.cwd();
  const results: string[] = [];

  function walk(dir: string) {
    if (results.length > 200) return;
    try {
      for (const entry of readdirSync(dir)) {
        if (entry.startsWith(".") || entry === "node_modules") continue;
        const full = join(dir, entry);
        try {
          const stat = statSync(full);
          if (stat.isDirectory()) walk(full);
          else if (matchGlob(entry, pattern)) results.push(relative(base, full));
        } catch { /* skip inaccessible */ }
      }
    } catch { /* skip */ }
  }

  walk(base);
  return results.length > 0 ? results.join("\n") : "No files found";
}

function matchGlob(filename: string, pattern: string): boolean {
  const re = pattern
    .replace(/\*\*/g, "<<DOUBLESTAR>>")
    .replace(/\*/g, "[^/]*")
    .replace(/<<DOUBLESTAR>>/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${re}$`).test(filename);
}

function grepFiles(pattern: string, searchPath?: string, include?: string): string {
  const path = searchPath || ".";
  try {
    const cmd = include
      ? `rg --no-heading -n "${pattern}" --glob "${include}" "${path}" 2>/dev/null || grep -rn "${pattern}" --include="${include}" "${path}" 2>/dev/null`
      : `rg --no-heading -n "${pattern}" "${path}" 2>/dev/null || grep -rn "${pattern}" "${path}" 2>/dev/null`;
    return execSync(cmd, { encoding: "utf-8", timeout: 10000, cwd: process.cwd() }).slice(0, 15000) || "No matches";
  } catch {
    return "No matches found";
  }
}

function executeTool(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "Bash": return executeBash(input.command as string);
    case "Read": return readFile(input.file_path as string, input.offset as number | undefined, input.limit as number | undefined);
    case "Write": return writeFileTool(input.file_path as string, input.content as string);
    case "Edit": return editFile(input.file_path as string, input.old_string as string, input.new_string as string);
    case "Glob": return globFiles(input.pattern as string, input.path as string | undefined);
    case "Grep": return grepFiles(input.pattern as string, input.path as string | undefined, input.include as string | undefined);
    default: return `Unknown tool: ${name}`;
  }
}

// ── Token Tracking ────────────────────────────────────────────────

interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheCreation: number;
}

const totalUsage: Usage = { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreation: 0 };

function updateUsage(u: Anthropic.Usage) {
  totalUsage.inputTokens += u.input_tokens;
  totalUsage.outputTokens += u.output_tokens;
  const cu = u as unknown as Record<string, number>;
  totalUsage.cacheRead += cu.cache_read_input_tokens ?? 0;
  totalUsage.cacheCreation += cu.cache_creation_input_tokens ?? 0;
}

function formatCost(): string {
  const inputCost = totalUsage.inputTokens * 3 / 1_000_000;
  const outputCost = totalUsage.outputTokens * 15 / 1_000_000;
  const total = inputCost + outputCost;
  return `${c.dim}tokens: ${totalUsage.inputTokens}in/${totalUsage.outputTokens}out | cost: ~$${total.toFixed(4)}${c.reset}`;
}

// ── Streaming Agent Loop ──────────────────────────────────────────

const SYSTEM_PROMPT = `You are a powerful coding assistant with tools for file I/O, shell commands, and codebase search. Use them to accomplish tasks efficiently.

Rules:
- Read files before editing them
- Use Edit for small changes, Write for new files
- Use Glob/Grep to find relevant files before diving in
- Be concise`;

async function agentLoop(messages: Anthropic.MessageParam[]): Promise<string> {
  while (true) {
    const stream = client.messages.stream({
      model: "claude-sonnet-4-20250514",
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      tools,
      messages,
    });

    const contentBlocks: Anthropic.ContentBlock[] = [];
    let currentText = "";

    stream.on("text", (text) => {
      process.stdout.write(text);
      currentText += text;
    });

    const response = await stream.finalMessage();
    updateUsage(response.usage);

    for (const block of response.content) {
      contentBlocks.push(block);
    }

    const toolUses = contentBlocks.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
      console.log(`\n${formatCost()}`);
      return currentText;
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = toolUses.map((tool) => {
      const input = tool.input as Record<string, unknown>;
      console.log(`\n${c.cyan}[${tool.name}]${c.reset} ${formatToolInput(tool.name, input)}`);
      const output = executeTool(tool.name, input);
      const preview = output.slice(0, 400);
      if (preview.trim()) console.log(`${c.dim}${preview}${output.length > 400 ? "..." : ""}${c.reset}`);
      return { type: "tool_result" as const, tool_use_id: tool.id, content: output };
    });
    messages.push({ role: "user", content: toolResults });
  }
}

function formatToolInput(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "Bash": return `$ ${input.command}`;
    case "Read": return `${input.file_path}`;
    case "Write": return `${input.file_path}`;
    case "Edit": return `${input.file_path}`;
    case "Glob": return `${input.pattern} in ${input.path || "."}`;
    case "Grep": return `/${input.pattern}/ in ${input.path || "."}`;
    default: return JSON.stringify(input);
  }
}

// ── REPL ──────────────────────────────────────────────────────────

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log(`${c.bold}minicc v2${c.reset} — Streaming Agent (Bash/Read/Write/Edit/Glob/Grep)`);
  console.log(`${c.dim}Type 'exit' to quit, 'cost' to see usage${c.reset}\n`);

  const messages: Anthropic.MessageParam[] = [];

  const ask = () =>
    rl.question(`${c.green}>${c.reset} `, async (input) => {
      const trimmed = input.trim().toLowerCase();
      if (trimmed === "exit") return rl.close();
      if (trimmed === "cost") { console.log(formatCost()); return ask(); }
      if (!input.trim()) return ask();

      messages.push({ role: "user", content: input });
      try {
        await agentLoop(messages);
      } catch (e: unknown) {
        console.error(`${c.red}Error:${c.reset}`, (e as Error).message);
      }
      console.log();
      ask();
    });
  ask();
}

main();
