#!/usr/bin/env npx tsx
/**
 * s03 — TodoWrite (~250 lines)
 *
 * An agent without a plan drifts; list the steps first, then execute.
 * TodoWrite gives the model explicit planning capability.
 *
 * SOURCE MAPPING:
 *   tools/TodoWriteTool/ → buildTool with todos array schema
 *   State stored in-memory (original uses AppState)
 *   Distilled: same schema, simpler state management
 */

import Anthropic from "@anthropic-ai/sdk";
import { execSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname, resolve } from "path";
import * as readline from "readline";

const client = new Anthropic();
const MODEL = process.env.MINICC_MODEL || "claude-sonnet-4-20250514";
const c = { reset: "\x1b[0m", dim: "\x1b[90m", cyan: "\x1b[36m", green: "\x1b[32m", yellow: "\x1b[33m" };

// --- Todo State ---
interface TodoItem { id: string; content: string; status: "pending" | "in_progress" | "completed" | "cancelled"; }
let todos: TodoItem[] = [];

// --- Tool Handlers ---
type ToolHandler = (input: Record<string, unknown>) => string;

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  Bash: (input) => {
    try { return execSync(input.command as string, { encoding: "utf-8", timeout: 30_000, cwd: process.cwd() }).slice(0, 15_000); }
    catch (e: unknown) { const err = e as { stdout?: string; stderr?: string; message?: string }; return [err.stdout, err.stderr, err.message].filter(Boolean).join("\n").slice(0, 15_000); }
  },
  Read: (input) => {
    try {
      const lines = readFileSync(resolve(input.file_path as string), "utf-8").split("\n");
      const s = Math.max(0, ((input.offset as number) ?? 1) - 1);
      const e = input.limit ? s + (input.limit as number) : lines.length;
      return lines.slice(s, e).map((l, i) => `${String(s + i + 1).padStart(6)}|${l}`).join("\n") || "(empty)";
    } catch (e: unknown) { return `Error: ${(e as Error).message}`; }
  },
  Write: (input) => {
    try {
      const p = resolve(input.file_path as string); const dir = dirname(p);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(p, input.content as string, "utf-8"); return `Written: ${p}`;
    } catch (e: unknown) { return `Error: ${(e as Error).message}`; }
  },
  Edit: (input) => {
    try {
      const p = resolve(input.file_path as string); const content = readFileSync(p, "utf-8");
      const old = input.old_string as string; const count = content.split(old).length - 1;
      if (count === 0) return `Error: not found`; if (count > 1) return `Error: ${count} matches`;
      writeFileSync(p, content.replace(old, input.new_string as string), "utf-8"); return `Edited: ${p}`;
    } catch (e: unknown) { return `Error: ${(e as Error).message}`; }
  },
  TodoWrite: (input) => {
    const items = input.todos as TodoItem[];
    for (const item of items) {
      const existing = todos.find((t) => t.id === item.id);
      if (existing) { existing.content = item.content; existing.status = item.status; }
      else todos.push(item);
    }
    return renderTodos();
  },
};

function renderTodos(): string {
  if (todos.length === 0) return "No todos";
  const icons: Record<string, string> = { pending: "○", in_progress: "◉", completed: "✓", cancelled: "✗" };
  return todos.map((t) => `${icons[t.status]} [${t.status}] ${t.id}: ${t.content}`).join("\n");
}

const TOOLS: Anthropic.Tool[] = [
  { name: "Bash", description: "Run a shell command.", input_schema: { type: "object" as const, properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "Read", description: "Read a file with line numbers.", input_schema: { type: "object" as const, properties: { file_path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } }, required: ["file_path"] } },
  { name: "Write", description: "Write content to a file.", input_schema: { type: "object" as const, properties: { file_path: { type: "string" }, content: { type: "string" } }, required: ["file_path", "content"] } },
  { name: "Edit", description: "Find-replace unique string.", input_schema: { type: "object" as const, properties: { file_path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } }, required: ["file_path", "old_string", "new_string"] } },
  {
    name: "TodoWrite",
    description: "Create or update a structured task list for planning multi-step work.",
    input_schema: {
      type: "object" as const,
      properties: {
        todos: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" }, content: { type: "string" },
              status: { type: "string", enum: ["pending", "in_progress", "completed", "cancelled"] },
            },
            required: ["id", "content", "status"],
          },
        },
      },
      required: ["todos"],
    },
  },
];

function fmt(name: string, input: Record<string, unknown>): string {
  if (name === "Bash") return `$ ${input.command}`;
  if (name === "TodoWrite") return `${(input.todos as TodoItem[]).length} items`;
  return String(input.file_path ?? "");
}

async function agentLoop(messages: Anthropic.MessageParam[]) {
  for (let turn = 0; turn < 50; turn++) {
    const response = await client.messages.create({
      model: MODEL, max_tokens: 8192,
      system: "You are a coding assistant. Use TodoWrite to plan complex tasks before starting. Read before editing.",
      tools: TOOLS, messages,
    });
    for (const b of response.content) if (b.type === "text") process.stdout.write(b.text);
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") { console.log(); return; }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const b of response.content) {
      if (b.type !== "tool_use") continue;
      const input = b.input as Record<string, unknown>;
      console.log(`\n${c.cyan}[${b.name}]${c.reset} ${fmt(b.name, input)}`);
      const output = (TOOL_HANDLERS[b.name] ?? (() => "Unknown tool"))(input);
      const preview = output.slice(0, 300);
      if (preview.trim()) console.log(`${c.dim}${preview}${output.length > 300 ? "..." : ""}${c.reset}`);
      results.push({ type: "tool_result", tool_use_id: b.id, content: output });
    }
    messages.push({ role: "user", content: results });
  }
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log("minicc s03 — TodoWrite (plan first, then execute)");
  const messages: Anthropic.MessageParam[] = [];
  const ask = () =>
    rl.question(`${c.green}>${c.reset} `, async (input) => {
      const cmd = input.trim().toLowerCase();
      if (cmd === "exit") return rl.close();
      if (cmd === "todos") { console.log(renderTodos()); return ask(); }
      if (!input.trim()) return ask();
      messages.push({ role: "user", content: input });
      try { await agentLoop(messages); } catch (e: unknown) { console.error((e as Error).message); }
      ask();
    });
  ask();
}
main();
