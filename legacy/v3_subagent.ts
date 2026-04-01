#!/usr/bin/env npx tsx
/**
 * v3_subagent.ts — Sub-agent & Todo System (~600 lines)
 *
 * Core insight: Complex tasks benefit from divide-and-conquer.
 * A "Task" tool spawns an isolated sub-agent with its own context,
 * preventing the main conversation from getting polluted with
 * intermediate exploration details.
 *
 * New in v3:
 *   - Task tool (sub-agents with isolated context)
 *   - TodoWrite tool (explicit task planning)
 *   - Multi-turn conversation memory
 *   - AbortController for cancellation
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
const c = { reset: "\x1b[0m", dim: "\x1b[90m", cyan: "\x1b[36m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", bold: "\x1b[1m", magenta: "\x1b[35m" };

// ── Types ─────────────────────────────────────────────────────────

interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
}

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

// ── State ─────────────────────────────────────────────────────────

let todos: TodoItem[] = [];
const totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

// ── Tool Definitions ──────────────────────────────────────────────

const baseTools: Anthropic.Tool[] = [
  {
    name: "Bash",
    description: "Run a shell command.",
    input_schema: {
      type: "object" as const,
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  {
    name: "Read",
    description: "Read a file with line numbers.",
    input_schema: {
      type: "object" as const,
      properties: {
        file_path: { type: "string" },
        offset: { type: "number" },
        limit: { type: "number" },
      },
      required: ["file_path"],
    },
  },
  {
    name: "Write",
    description: "Write content to a file (creates dirs as needed).",
    input_schema: {
      type: "object" as const,
      properties: {
        file_path: { type: "string" },
        content: { type: "string" },
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
        old_string: { type: "string" },
        new_string: { type: "string" },
      },
      required: ["file_path", "old_string", "new_string"],
    },
  },
  {
    name: "Glob",
    description: "Find files matching a glob pattern.",
    input_schema: {
      type: "object" as const,
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "Grep",
    description: "Search file contents with regex.",
    input_schema: {
      type: "object" as const,
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        include: { type: "string" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "TodoWrite",
    description: "Create or update a structured task list. Use for planning complex multi-step work.",
    input_schema: {
      type: "object" as const,
      properties: {
        todos: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              content: { type: "string" },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed", "cancelled"],
              },
            },
            required: ["id", "content", "status"],
          },
        },
      },
      required: ["todos"],
    },
  },
  {
    name: "Task",
    description:
      "Launch a sub-agent to handle a complex subtask in isolation. The sub-agent has its own context and tools. Use for exploration, research, or independent work that shouldn't pollute the main conversation.",
    input_schema: {
      type: "object" as const,
      properties: {
        description: {
          type: "string",
          description: "Short description of the task (3-5 words)",
        },
        prompt: {
          type: "string",
          description: "Detailed instructions for the sub-agent",
        },
      },
      required: ["description", "prompt"],
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

function readFileTool(filePath: string, offset?: number, limit?: number): string {
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

function editFileTool(filePath: string, oldStr: string, newStr: string): string {
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
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }
  walk(base);
  return results.length > 0 ? results.join("\n") : "No files found";
}

function matchGlob(filename: string, pattern: string): boolean {
  const cleaned = pattern.replace(/^\*\*\//, "");
  const re = cleaned.replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${re}$`).test(filename);
}

function grepFiles(pattern: string, searchPath?: string, include?: string): string {
  const path = searchPath || ".";
  try {
    const globArg = include ? `--glob "${include}"` : "";
    const cmd = `rg --no-heading -n "${pattern}" ${globArg} "${path}" 2>/dev/null | head -100`;
    return execSync(cmd, { encoding: "utf-8", timeout: 10000, cwd: process.cwd() }).slice(0, 15000) || "No matches";
  } catch {
    return "No matches found";
  }
}

function todoWrite(items: TodoItem[]): string {
  for (const item of items) {
    const existing = todos.find((t) => t.id === item.id);
    if (existing) {
      existing.content = item.content;
      existing.status = item.status;
    } else {
      todos.push(item);
    }
  }
  return todos.map((t) => {
    const icon = { pending: "○", in_progress: "◉", completed: "✓", cancelled: "✗" }[t.status];
    return `${icon} [${t.status}] ${t.id}: ${t.content}`;
  }).join("\n");
}

// ── Sub-Agent ─────────────────────────────────────────────────────

async function runSubAgent(description: string, prompt: string, depth: number): Promise<string> {
  if (depth > 3) return "Error: Maximum sub-agent nesting depth (3) reached";

  console.log(`\n${c.magenta}  ⤷ Sub-agent: ${description}${c.reset}`);

  const subTools = baseTools.filter((t) => t.name !== "Task" || depth < 2);
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];
  let result = "";

  for (let turn = 0; turn < 20; turn++) {
    const stream = client.messages.stream({
      model: "claude-sonnet-4-20250514",
      max_tokens: 8192,
      system: "You are a focused sub-agent. Complete the given task efficiently and return a clear summary of what you found or did.",
      tools: subTools,
      messages,
    });

    let turnText = "";
    stream.on("text", (text) => {
      process.stdout.write(`${c.dim}${text}${c.reset}`);
      turnText += text;
    });

    const response = await stream.finalMessage();
    totalUsage.inputTokens += response.usage.input_tokens;
    totalUsage.outputTokens += response.usage.output_tokens;

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );

    messages.push({ role: "assistant", content: response.content });
    result = turnText;

    if (response.stop_reason !== "tool_use" || toolUses.length === 0) break;

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const tool of toolUses) {
      const input = tool.input as Record<string, unknown>;
      console.log(`\n${c.dim}  [${tool.name}] ${formatToolInput(tool.name, input)}${c.reset}`);
      let output: string;
      if (tool.name === "Task") {
        output = await runSubAgent(input.description as string, input.prompt as string, depth + 1);
      } else {
        output = executeTool(tool.name, input);
      }
      toolResults.push({ type: "tool_result", tool_use_id: tool.id, content: output });
    }
    messages.push({ role: "user", content: toolResults });
  }

  console.log(`${c.magenta}  ⤶ Sub-agent done${c.reset}`);
  return result || "Sub-agent completed without text output";
}

function executeTool(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "Bash": return executeBash(input.command as string);
    case "Read": return readFileTool(input.file_path as string, input.offset as number | undefined, input.limit as number | undefined);
    case "Write": return writeFileTool(input.file_path as string, input.content as string);
    case "Edit": return editFileTool(input.file_path as string, input.old_string as string, input.new_string as string);
    case "Glob": return globFiles(input.pattern as string, input.path as string | undefined);
    case "Grep": return grepFiles(input.pattern as string, input.path as string | undefined, input.include as string | undefined);
    case "TodoWrite": return todoWrite(input.todos as TodoItem[]);
    default: return `Unknown tool: ${name}`;
  }
}

function formatToolInput(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "Bash": return `$ ${input.command}`;
    case "Read": return `${input.file_path}`;
    case "Write": return `${input.file_path}`;
    case "Edit": return `${input.file_path}`;
    case "Glob": return `${input.pattern}`;
    case "Grep": return `/${input.pattern}/`;
    case "Task": return `${input.description}`;
    case "TodoWrite": return `${(input.todos as TodoItem[]).length} items`;
    default: return JSON.stringify(input);
  }
}

// ── Main Agent Loop ───────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a powerful coding assistant with file I/O, shell, search, planning, and sub-agent tools.

Key capabilities:
- Use TodoWrite to plan complex multi-step tasks before starting
- Use Task to delegate exploration or independent subtasks to sub-agents
- Sub-agents have isolated context — great for research without polluting your main conversation
- Read files before editing them
- Use Glob/Grep to find relevant code

Be concise and efficient.`;

async function agentLoop(messages: Anthropic.MessageParam[]): Promise<string> {
  for (let turn = 0; turn < 50; turn++) {
    const stream = client.messages.stream({
      model: "claude-sonnet-4-20250514",
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      tools: baseTools,
      messages,
    });

    let currentText = "";
    stream.on("text", (text) => {
      process.stdout.write(text);
      currentText += text;
    });

    const response = await stream.finalMessage();
    totalUsage.inputTokens += response.usage.input_tokens;
    totalUsage.outputTokens += response.usage.output_tokens;

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
      const cost = (totalUsage.inputTokens * 3 + totalUsage.outputTokens * 15) / 1_000_000;
      console.log(`\n${c.dim}[${totalUsage.inputTokens}in/${totalUsage.outputTokens}out ~$${cost.toFixed(4)}]${c.reset}`);
      return currentText;
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const tool of toolUses) {
      const input = tool.input as Record<string, unknown>;
      console.log(`\n${c.cyan}[${tool.name}]${c.reset} ${formatToolInput(tool.name, input)}`);

      let output: string;
      if (tool.name === "Task") {
        output = await runSubAgent(input.description as string, input.prompt as string, 1);
      } else {
        output = executeTool(tool.name, input);
      }

      const preview = output.slice(0, 400);
      if (preview.trim() && tool.name !== "Task") {
        console.log(`${c.dim}${preview}${output.length > 400 ? "..." : ""}${c.reset}`);
      }
      toolResults.push({ type: "tool_result", tool_use_id: tool.id, content: output });
    }
    messages.push({ role: "user", content: toolResults });
  }
  return "Max turns reached";
}

// ── REPL ──────────────────────────────────────────────────────────

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log(`${c.bold}minicc v3${c.reset} — Sub-agent & Todo Agent`);
  console.log(`${c.dim}Commands: exit, cost, todos${c.reset}\n`);

  const messages: Anthropic.MessageParam[] = [];

  const ask = () =>
    rl.question(`${c.green}>${c.reset} `, async (input) => {
      const cmd = input.trim().toLowerCase();
      if (cmd === "exit") return rl.close();
      if (cmd === "cost") {
        const cost = (totalUsage.inputTokens * 3 + totalUsage.outputTokens * 15) / 1_000_000;
        console.log(`${c.dim}${totalUsage.inputTokens}in/${totalUsage.outputTokens}out ~$${cost.toFixed(4)}${c.reset}`);
        return ask();
      }
      if (cmd === "todos") {
        if (todos.length === 0) console.log(`${c.dim}No todos yet${c.reset}`);
        else todos.forEach((t) => {
          const icon = { pending: "○", in_progress: "◉", completed: "✓", cancelled: "✗" }[t.status];
          console.log(`  ${icon} ${t.content}`);
        });
        return ask();
      }
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
