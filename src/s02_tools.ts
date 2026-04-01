#!/usr/bin/env npx tsx
/**
 * s02 — Tools (~200 lines)
 *
 * The loop stays the same; new tools register into the dispatch map.
 * Four tools cover 90% of coding tasks: Bash, Read, Write, Edit.
 *
 * SOURCE MAPPING:
 *   tools.ts:getAllBaseTools() → 30+ tools registered via buildTool()
 *   Tool.ts → Tool interface with call(), inputSchema, checkPermissions...
 *   Distilled: dispatch Map<string, handler> is the essential pattern
 */

import Anthropic from "@anthropic-ai/sdk";
import { execSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname, resolve } from "path";
import * as readline from "readline";

const client = new Anthropic();
const MODEL = process.env.MINICC_MODEL || "claude-sonnet-4-20250514";

// --- Tool dispatch map (the pattern from tools.ts) ---
type ToolHandler = (input: Record<string, unknown>) => string;

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  Bash: (input) => {
    try {
      return execSync(input.command as string, { encoding: "utf-8", timeout: 30_000, cwd: process.cwd() }).slice(0, 15_000);
    } catch (e: unknown) {
      const err = e as { stdout?: string; stderr?: string; message?: string };
      return [err.stdout, err.stderr, err.message].filter(Boolean).join("\n").slice(0, 15_000);
    }
  },
  Read: (input) => {
    try {
      const lines = readFileSync(resolve(input.file_path as string), "utf-8").split("\n");
      const start = Math.max(0, ((input.offset as number) ?? 1) - 1);
      const end = input.limit ? start + (input.limit as number) : lines.length;
      return lines.slice(start, end).map((l, i) => `${String(start + i + 1).padStart(6)}|${l}`).join("\n") || "(empty)";
    } catch (e: unknown) { return `Error: ${(e as Error).message}`; }
  },
  Write: (input) => {
    try {
      const p = resolve(input.file_path as string);
      const dir = dirname(p);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(p, input.content as string, "utf-8");
      return `File written: ${p}`;
    } catch (e: unknown) { return `Error: ${(e as Error).message}`; }
  },
  Edit: (input) => {
    try {
      const p = resolve(input.file_path as string);
      const content = readFileSync(p, "utf-8");
      const old = input.old_string as string;
      const count = content.split(old).length - 1;
      if (count === 0) return `Error: old_string not found in ${p}`;
      if (count > 1) return `Error: old_string found ${count} times — must be unique`;
      writeFileSync(p, content.replace(old, input.new_string as string), "utf-8");
      return `Edited: ${p}`;
    } catch (e: unknown) { return `Error: ${(e as Error).message}`; }
  },
};

const TOOLS: Anthropic.Tool[] = [
  { name: "Bash", description: "Run a shell command.", input_schema: { type: "object" as const, properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "Read", description: "Read a file with line numbers.", input_schema: { type: "object" as const, properties: { file_path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } }, required: ["file_path"] } },
  { name: "Write", description: "Write content to a file.", input_schema: { type: "object" as const, properties: { file_path: { type: "string" }, content: { type: "string" } }, required: ["file_path", "content"] } },
  { name: "Edit", description: "Find and replace a unique string in a file.", input_schema: { type: "object" as const, properties: { file_path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } }, required: ["file_path", "old_string", "new_string"] } },
];

const c = { reset: "\x1b[0m", dim: "\x1b[90m", cyan: "\x1b[36m", green: "\x1b[32m" };

function fmt(name: string, input: Record<string, unknown>): string {
  if (name === "Bash") return `$ ${input.command}`;
  return String(input.file_path ?? JSON.stringify(input).slice(0, 80));
}

// --- Same agent loop as s01, now with dispatch ---
async function agentLoop(messages: Anthropic.MessageParam[]) {
  while (true) {
    const response = await client.messages.create({
      model: MODEL, max_tokens: 8192,
      system: "You are a coding assistant. Read files before editing. Use Edit for changes, Write for new files.",
      tools: TOOLS, messages,
    });

    for (const b of response.content)
      if (b.type === "text") process.stdout.write(b.text);

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") { console.log(); return; }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const b of response.content) {
      if (b.type !== "tool_use") continue;
      const input = b.input as Record<string, unknown>;
      console.log(`\n${c.cyan}[${b.name}]${c.reset} ${fmt(b.name, input)}`);
      const handler = TOOL_HANDLERS[b.name];
      const output = handler ? handler(input) : `Unknown tool: ${b.name}`;
      const preview = output.slice(0, 300);
      if (preview.trim()) console.log(`${c.dim}${preview}${output.length > 300 ? "..." : ""}${c.reset}`);
      results.push({ type: "tool_result", tool_use_id: b.id, content: output });
    }
    messages.push({ role: "user", content: results });
  }
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log("minicc s02 — Tools (Bash/Read/Write/Edit)");
  const messages: Anthropic.MessageParam[] = [];
  const ask = () =>
    rl.question(`${c.green}>${c.reset} `, async (input) => {
      if (input.trim().toLowerCase() === "exit") return rl.close();
      if (!input.trim()) return ask();
      messages.push({ role: "user", content: input });
      try { await agentLoop(messages); } catch (e: unknown) { console.error((e as Error).message); }
      ask();
    });
  ask();
}
main();
