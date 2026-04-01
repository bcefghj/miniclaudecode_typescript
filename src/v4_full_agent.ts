#!/usr/bin/env npx tsx
/**
 * v4_full_agent.ts — Full Agent with Skills & Permissions (~800 lines)
 *
 * The complete miniclaudecode distillation. Includes everything from v0-v3
 * plus:
 *   - Permission system (ask before destructive operations)
 *   - Skill system (load domain expertise from SKILL.md files)
 *   - System prompt with rules and context
 *   - Conversation compaction (summarize when context grows too large)
 *   - Graceful error handling and retry
 *
 * This is the "production" version — a fully functional coding agent
 * in ~800 lines, distilled from Claude Code's 500K+ lines.
 */

import Anthropic from "@anthropic-ai/sdk";
import { execSync, spawn } from "child_process";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  statSync,
} from "fs";
import { dirname, join, relative, resolve, basename } from "path";
import * as readline from "readline";

const client = new Anthropic();
const MODEL = process.env.MINICC_MODEL || "claude-sonnet-4-20250514";
const MAX_CONTEXT_TOKENS = 180_000;

const c = {
  reset: "\x1b[0m", dim: "\x1b[90m", cyan: "\x1b[36m", green: "\x1b[32m",
  yellow: "\x1b[33m", red: "\x1b[31m", bold: "\x1b[1m", magenta: "\x1b[35m",
  blue: "\x1b[34m",
};

// ── Types ─────────────────────────────────────────────────────────

interface TodoItem { id: string; content: string; status: "pending" | "in_progress" | "completed" | "cancelled"; }
interface TokenUsage { inputTokens: number; outputTokens: number; }
type PermissionRule = { tool: string; pattern?: string; action: "allow" | "deny" };

// ── State ─────────────────────────────────────────────────────────

let todos: TodoItem[] = [];
const totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
const permissionRules: PermissionRule[] = [
  { tool: "Read", action: "allow" },
  { tool: "Glob", action: "allow" },
  { tool: "Grep", action: "allow" },
  { tool: "TodoWrite", action: "allow" },
];
const sessionAllowed = new Set<string>();
let rlInstance: readline.Interface | null = null;

// ── Permission System ─────────────────────────────────────────────

function checkPermission(toolName: string, input: Record<string, unknown>): "allow" | "deny" | "ask" {
  const inputStr = JSON.stringify(input);
  const sessionKey = `${toolName}:${inputStr}`;
  if (sessionAllowed.has(sessionKey) || sessionAllowed.has(`${toolName}:*`)) return "allow";

  for (const rule of permissionRules) {
    if (rule.tool === toolName) {
      if (!rule.pattern || inputStr.includes(rule.pattern)) return rule.action;
    }
  }
  // Read-only tools are always allowed
  if (["Read", "Glob", "Grep", "TodoWrite"].includes(toolName)) return "allow";
  return "ask";
}

async function askPermission(toolName: string, input: Record<string, unknown>): Promise<boolean> {
  if (!rlInstance) return true;
  const inputStr = formatToolInput(toolName, input);
  return new Promise((resolve) => {
    rlInstance!.question(
      `${c.yellow}Allow ${toolName}: ${inputStr}? [y/n/a(lways)] ${c.reset}`,
      (answer) => {
        const a = answer.trim().toLowerCase();
        if (a === "a") {
          sessionAllowed.add(`${toolName}:*`);
          resolve(true);
        } else {
          if (a === "y") sessionAllowed.add(`${toolName}:${JSON.stringify(input)}`);
          resolve(a === "y" || a === "a");
        }
      }
    );
  });
}

// ── Skill System ──────────────────────────────────────────────────

function loadSkills(): string {
  const skillDirs = [
    join(process.cwd(), ".cursor", "skills"),
    join(process.cwd(), ".minicc", "skills"),
    join(process.cwd(), "skills"),
  ];

  const skills: string[] = [];
  for (const dir of skillDirs) {
    if (!existsSync(dir)) continue;
    try {
      for (const entry of readdirSync(dir, { recursive: true }) as string[]) {
        if (entry.endsWith("SKILL.md") || entry.endsWith("skill.md")) {
          const content = readFileSync(join(dir, entry), "utf-8");
          skills.push(`## Skill: ${entry}\n${content.slice(0, 2000)}`);
        }
      }
    } catch { /* skip */ }
  }
  return skills.length > 0
    ? `\n\n# Available Skills\n${skills.join("\n\n")}`
    : "";
}

function loadRules(): string {
  const ruleFiles = [
    join(process.cwd(), ".cursor", "rules"),
    join(process.cwd(), ".minicc", "rules"),
    join(process.cwd(), "AGENTS.md"),
    join(process.cwd(), "CLAUDE.md"),
  ];

  const rules: string[] = [];
  for (const path of ruleFiles) {
    try {
      if (existsSync(path)) {
        const stat = statSync(path);
        if (stat.isFile()) {
          rules.push(readFileSync(path, "utf-8").slice(0, 2000));
        } else if (stat.isDirectory()) {
          for (const f of readdirSync(path)) {
            if (f.endsWith(".md") || f.endsWith(".mdc")) {
              rules.push(readFileSync(join(path, f), "utf-8").slice(0, 1000));
            }
          }
        }
      }
    } catch { /* skip */ }
  }
  return rules.length > 0
    ? `\n\n# Project Rules\n${rules.join("\n\n")}`
    : "";
}

// ── Tool Definitions ──────────────────────────────────────────────

const allTools: Anthropic.Tool[] = [
  {
    name: "Bash",
    description: "Run a shell command. Use for git, build, test, and system operations.",
    input_schema: {
      type: "object" as const,
      properties: {
        command: { type: "string", description: "Command to execute" },
        timeout: { type: "number", description: "Timeout in ms (default 30000)" },
      },
      required: ["command"],
    },
  },
  {
    name: "Read",
    description: "Read a file with line numbers. Supports offset/limit for large files.",
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
        content: { type: "string" },
      },
      required: ["file_path", "content"],
    },
  },
  {
    name: "Edit",
    description: "Find and replace a unique string in a file. old_string must match exactly.",
    input_schema: {
      type: "object" as const,
      properties: {
        file_path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
        replace_all: { type: "boolean", description: "Replace all occurrences (default false)" },
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
        pattern: { type: "string", description: 'e.g. "**/*.ts"' },
        path: { type: "string", description: "Search directory (default cwd)" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "Grep",
    description: "Search file contents with regex (uses ripgrep).",
    input_schema: {
      type: "object" as const,
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        include: { type: "string", description: 'File glob filter, e.g. "*.ts"' },
      },
      required: ["pattern"],
    },
  },
  {
    name: "TodoWrite",
    description: "Create or update a todo list for planning multi-step tasks.",
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
              status: { type: "string", enum: ["pending", "in_progress", "completed", "cancelled"] },
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
    description: "Launch an isolated sub-agent for exploration or independent subtasks.",
    input_schema: {
      type: "object" as const,
      properties: {
        description: { type: "string", description: "Short task description" },
        prompt: { type: "string", description: "Detailed instructions for the sub-agent" },
      },
      required: ["description", "prompt"],
    },
  },
];

// ── Tool Implementations ──────────────────────────────────────────

function executeBash(command: string, timeout?: number): string {
  try {
    return execSync(command, {
      encoding: "utf-8",
      timeout: timeout ?? 30000,
      cwd: process.cwd(),
      env: { ...process.env, FORCE_COLOR: "0" },
    }).slice(0, 20000);
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string; status?: number };
    const parts = [err.stdout, err.stderr].filter(Boolean).join("\n");
    return (parts || err.message || "Command failed").slice(0, 20000);
  }
}

function readFileTool(filePath: string, offset?: number, limit?: number): string {
  try {
    const absPath = resolve(filePath);
    const content = readFileSync(absPath, "utf-8");
    const lines = content.split("\n");
    const start = Math.max(0, (offset ?? 1) - 1);
    const end = limit ? Math.min(start + limit, lines.length) : lines.length;
    return lines.slice(start, end).map((l, i) => `${String(start + i + 1).padStart(6)}|${l}`).join("\n");
  } catch (e: unknown) {
    return `Error reading file: ${(e as Error).message}`;
  }
}

function writeFileTool(filePath: string, content: string): string {
  try {
    const absPath = resolve(filePath);
    const dir = dirname(absPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(absPath, content, "utf-8");
    return `File written successfully: ${absPath}`;
  } catch (e: unknown) {
    return `Error: ${(e as Error).message}`;
  }
}

function editFileTool(filePath: string, oldStr: string, newStr: string, replaceAll?: boolean): string {
  try {
    const absPath = resolve(filePath);
    let content = readFileSync(absPath, "utf-8");

    if (oldStr === "" && newStr !== "") {
      // Create mode: old_string empty means create new file with new_string
      if (existsSync(absPath)) return "Error: File already exists. Use non-empty old_string to edit.";
      writeFileTool(absPath, newStr);
      return `Created: ${absPath}`;
    }

    const count = content.split(oldStr).length - 1;
    if (count === 0) return `Error: old_string not found in ${filePath}`;
    if (count > 1 && !replaceAll) return `Error: old_string found ${count} times — use replace_all or provide more context`;

    if (replaceAll) {
      content = content.split(oldStr).join(newStr);
    } else {
      content = content.replace(oldStr, newStr);
    }
    writeFileSync(absPath, content, "utf-8");
    return `Edited: ${absPath}${replaceAll ? ` (${count} replacements)` : ""}`;
  } catch (e: unknown) {
    return `Error: ${(e as Error).message}`;
  }
}

function globFiles(pattern: string, searchPath?: string): string {
  const base = resolve(searchPath || process.cwd());
  const results: string[] = [];
  const cleaned = pattern.replace(/^\*\*\//, "");

  function walk(dir: string, depth: number) {
    if (results.length > 500 || depth > 15) return;
    try {
      for (const entry of readdirSync(dir)) {
        if (entry.startsWith(".") || entry === "node_modules" || entry === "dist") continue;
        const full = join(dir, entry);
        try {
          const stat = statSync(full);
          if (stat.isDirectory()) walk(full, depth + 1);
          else {
            const re = new RegExp("^" + cleaned.replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
            if (re.test(entry)) results.push(relative(base, full));
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }
  walk(base, 0);
  return results.length > 0 ? results.sort().join("\n") : "No files found";
}

function grepFiles(pattern: string, searchPath?: string, include?: string): string {
  const path = resolve(searchPath || process.cwd());
  try {
    const globArg = include ? `--glob "${include}"` : "";
    return execSync(`rg --no-heading -n "${pattern}" ${globArg} "${path}" 2>/dev/null | head -150`, {
      encoding: "utf-8", timeout: 10000,
    }).slice(0, 20000) || "No matches";
  } catch {
    return "No matches found";
  }
}

function todoWriteTool(items: TodoItem[]): string {
  for (const item of items) {
    const existing = todos.find((t) => t.id === item.id);
    if (existing) { existing.content = item.content; existing.status = item.status; }
    else todos.push(item);
  }
  return todos.map((t) => {
    const icon = { pending: "○", in_progress: "◉", completed: "✓", cancelled: "✗" }[t.status];
    return `${icon} [${t.status}] ${t.id}: ${t.content}`;
  }).join("\n");
}

async function executeTool(name: string, input: Record<string, unknown>): Promise<string> {
  switch (name) {
    case "Bash": return executeBash(input.command as string, input.timeout as number | undefined);
    case "Read": return readFileTool(input.file_path as string, input.offset as number | undefined, input.limit as number | undefined);
    case "Write": return writeFileTool(input.file_path as string, input.content as string);
    case "Edit": return editFileTool(input.file_path as string, input.old_string as string, input.new_string as string, input.replace_all as boolean | undefined);
    case "Glob": return globFiles(input.pattern as string, input.path as string | undefined);
    case "Grep": return grepFiles(input.pattern as string, input.path as string | undefined, input.include as string | undefined);
    case "TodoWrite": return todoWriteTool(input.todos as TodoItem[]);
    default: return `Unknown tool: ${name}`;
  }
}

// ── Sub-Agent ─────────────────────────────────────────────────────

async function runSubAgent(description: string, prompt: string, depth: number): Promise<string> {
  if (depth > 3) return "Error: Maximum nesting depth (3) reached";
  console.log(`\n${c.magenta}  ⤷ Sub-agent: ${description}${c.reset}`);

  const subTools = allTools.filter((t) => t.name !== "Task" || depth < 2);
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];
  let result = "";

  for (let turn = 0; turn < 15; turn++) {
    const stream = client.messages.stream({
      model: MODEL, max_tokens: 8192,
      system: "You are a focused sub-agent. Complete the task and return a concise summary.",
      tools: subTools, messages,
    });

    let turnText = "";
    stream.on("text", (t) => { process.stdout.write(`${c.dim}${t}${c.reset}`); turnText += t; });
    const response = await stream.finalMessage();
    totalUsage.inputTokens += response.usage.input_tokens;
    totalUsage.outputTokens += response.usage.output_tokens;

    const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    messages.push({ role: "assistant", content: response.content });
    result = turnText;

    if (response.stop_reason !== "tool_use" || toolUses.length === 0) break;

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const tool of toolUses) {
      const inp = tool.input as Record<string, unknown>;
      console.log(`\n${c.dim}  [${tool.name}] ${formatToolInput(tool.name, inp)}${c.reset}`);
      const output = tool.name === "Task"
        ? await runSubAgent(inp.description as string, inp.prompt as string, depth + 1)
        : await executeTool(tool.name, inp);
      toolResults.push({ type: "tool_result", tool_use_id: tool.id, content: output });
    }
    messages.push({ role: "user", content: toolResults });
  }
  console.log(`${c.magenta}  ⤶ Sub-agent done${c.reset}`);
  return result || "Sub-agent completed";
}

// ── Context Compaction ────────────────────────────────────────────

async function compactMessages(messages: Anthropic.MessageParam[]): Promise<Anthropic.MessageParam[]> {
  if (messages.length < 10) return messages;

  const estimatedTokens = JSON.stringify(messages).length / 4;
  if (estimatedTokens < MAX_CONTEXT_TOKENS * 0.75) return messages;

  console.log(`${c.yellow}[Compacting conversation: ${messages.length} messages → summary]${c.reset}`);

  const keepRecent = messages.slice(-6);
  const toSummarize = messages.slice(0, -6);

  const summary = await client.messages.create({
    model: MODEL, max_tokens: 2000,
    system: "Summarize this conversation concisely, preserving key decisions, file paths, and code changes made.",
    messages: [{ role: "user", content: `Summarize:\n${JSON.stringify(toSummarize).slice(0, 50000)}` }],
  });

  totalUsage.inputTokens += summary.usage.input_tokens;
  totalUsage.outputTokens += summary.usage.output_tokens;

  const summaryText = summary.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text).join("\n");

  return [
    { role: "user", content: `[Previous conversation summary]\n${summaryText}` },
    { role: "assistant", content: "I understand. I have the context from our previous conversation. How can I continue helping?" },
    ...keepRecent,
  ];
}

// ── System Prompt ─────────────────────────────────────────────────

function buildSystemPrompt(): string {
  const cwd = process.cwd();
  const projectName = basename(cwd);
  const skills = loadSkills();
  const rules = loadRules();

  return `You are a powerful AI coding assistant called minicc (mini Claude Code).
Working directory: ${cwd}
Project: ${projectName}

You have tools for file I/O (Read, Write, Edit), shell commands (Bash), codebase search (Glob, Grep), task planning (TodoWrite), and delegation (Task sub-agents).

## Key Rules
- ALWAYS read a file before editing it
- Use Edit for surgical changes to existing files
- Use Write only for creating new files
- Use Glob/Grep to find relevant files before making changes
- Use TodoWrite to plan complex multi-step tasks
- Use Task to delegate exploration or independent subtasks
- Be concise and efficient
- When making code changes, don't add obvious comments
${rules}${skills}`;
}

// ── Main Agent Loop ───────────────────────────────────────────────

function formatToolInput(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "Bash": return `$ ${input.command}`;
    case "Read": return String(input.file_path);
    case "Write": return String(input.file_path);
    case "Edit": return String(input.file_path);
    case "Glob": return String(input.pattern);
    case "Grep": return `/${input.pattern}/`;
    case "Task": return String(input.description);
    case "TodoWrite": return `${(input.todos as TodoItem[]).length} items`;
    default: return JSON.stringify(input).slice(0, 100);
  }
}

async function agentLoop(messages: Anthropic.MessageParam[]): Promise<string> {
  const systemPrompt = buildSystemPrompt();

  for (let turn = 0; turn < 50; turn++) {
    // Compact if needed
    messages = await compactMessages(messages);

    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 16384,
      system: systemPrompt,
      tools: allTools,
      messages,
    });

    let currentText = "";
    stream.on("text", (text) => {
      process.stdout.write(text);
      currentText += text;
    });

    let response: Anthropic.Message;
    try {
      response = await stream.finalMessage();
    } catch (e: unknown) {
      const msg = (e as Error).message;
      if (msg.includes("overloaded") || msg.includes("529")) {
        console.log(`\n${c.yellow}API overloaded, retrying in 5s...${c.reset}`);
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      throw e;
    }

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

    // Execute tools with permission checks
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const tool of toolUses) {
      const input = tool.input as Record<string, unknown>;
      const perm = checkPermission(tool.name, input);

      if (perm === "deny") {
        console.log(`\n${c.red}[${tool.name} DENIED]${c.reset} ${formatToolInput(tool.name, input)}`);
        toolResults.push({
          type: "tool_result", tool_use_id: tool.id,
          content: `Permission denied for ${tool.name}`, is_error: true,
        });
        continue;
      }

      if (perm === "ask") {
        const allowed = await askPermission(tool.name, input);
        if (!allowed) {
          console.log(`\n${c.red}[${tool.name} REJECTED]${c.reset}`);
          toolResults.push({
            type: "tool_result", tool_use_id: tool.id,
            content: `User rejected ${tool.name} operation`, is_error: true,
          });
          continue;
        }
      }

      console.log(`\n${c.cyan}[${tool.name}]${c.reset} ${formatToolInput(tool.name, input)}`);

      let output: string;
      if (tool.name === "Task") {
        output = await runSubAgent(input.description as string, input.prompt as string, 1);
      } else {
        output = await executeTool(tool.name, input);
      }

      const preview = output.slice(0, 500);
      if (preview.trim() && tool.name !== "Task") {
        console.log(`${c.dim}${preview}${output.length > 500 ? "..." : ""}${c.reset}`);
      }
      toolResults.push({ type: "tool_result", tool_use_id: tool.id, content: output });
    }
    messages.push({ role: "user", content: toolResults });
  }
  return "Max turns reached";
}

// ── REPL ──────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  // Non-interactive mode: pass prompt as argument
  if (args.length > 0 && args[0] !== "--help") {
    const prompt = args.join(" ");
    try {
      await agentLoop([{ role: "user", content: prompt }]);
    } catch (e: unknown) {
      console.error(`${c.red}Error:${c.reset}`, (e as Error).message);
      process.exit(1);
    }
    return;
  }

  if (args[0] === "--help") {
    console.log(`Usage: minicc [prompt]
  If prompt is given, runs non-interactively.
  Otherwise starts interactive REPL.
  
  Commands: exit, cost, todos, clear
  Env: ANTHROPIC_API_KEY, MINICC_MODEL`);
    return;
  }

  rlInstance = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log(`${c.bold}minicc v4${c.reset} — Full Agent (distilled from Claude Code)`);
  console.log(`${c.dim}Model: ${MODEL} | cwd: ${process.cwd()}`);
  console.log(`Commands: exit, cost, todos, clear${c.reset}\n`);

  const messages: Anthropic.MessageParam[] = [];

  const ask = () =>
    rlInstance!.question(`${c.green}>${c.reset} `, async (input) => {
      const cmd = input.trim().toLowerCase();
      if (cmd === "exit" || cmd === "quit") { rlInstance!.close(); return; }
      if (cmd === "cost") {
        const cost = (totalUsage.inputTokens * 3 + totalUsage.outputTokens * 15) / 1_000_000;
        console.log(`${c.dim}Tokens: ${totalUsage.inputTokens}in / ${totalUsage.outputTokens}out`);
        console.log(`Cost: ~$${cost.toFixed(4)}${c.reset}`);
        return ask();
      }
      if (cmd === "todos") {
        if (todos.length === 0) console.log(`${c.dim}No todos${c.reset}`);
        else todos.forEach((t) => {
          const icon = { pending: "○", in_progress: "◉", completed: "✓", cancelled: "✗" }[t.status];
          const color = { pending: c.dim, in_progress: c.yellow, completed: c.green, cancelled: c.red }[t.status];
          console.log(`  ${color}${icon} ${t.content}${c.reset}`);
        });
        return ask();
      }
      if (cmd === "clear") {
        messages.length = 0;
        console.log(`${c.dim}Conversation cleared${c.reset}`);
        return ask();
      }
      if (!input.trim()) return ask();

      messages.push({ role: "user", content: input });
      try {
        await agentLoop(messages);
      } catch (e: unknown) {
        console.error(`\n${c.red}Error:${c.reset}`, (e as Error).message);
      }
      console.log();
      ask();
    });
  ask();
}

main();
