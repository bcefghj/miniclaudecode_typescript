#!/usr/bin/env npx tsx
/**
 * s07 — Tasks: File-Based Task Graph (~350 lines)
 *
 * A file-based task graph with ordering, parallelism, and dependencies.
 * Each task is a JSON file; blockedBy[] forms a DAG.
 * When a task completes, it unlocks downstream tasks.
 *
 * SOURCE MAPPING:
 *   utils/tasks.ts (862 lines) → TaskManager here
 *   tools/TaskCreateTool/ (138 lines) → task_create
 *   tools/TaskUpdateTool/ (406 lines) → task_update
 *   TaskSchema: id, subject, description, status, owner, blocks, blockedBy
 *   Distillation ratio: 1530 lines → ~350 lines (4.4:1)
 */

import Anthropic from "@anthropic-ai/sdk";
import { execSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "fs";
import { dirname, resolve, join } from "path";
import * as readline from "readline";

const client = new Anthropic();
const MODEL = process.env.MINICC_MODEL || "claude-sonnet-4-20250514";
const c = { reset: "\x1b[0m", dim: "\x1b[90m", cyan: "\x1b[36m", green: "\x1b[32m", yellow: "\x1b[33m" };

// ── Task Manager (distilled from utils/tasks.ts) ──────────────────

interface Task {
  id: string;
  subject: string;
  description: string;
  status: "pending" | "in_progress" | "completed";
  owner?: string;
  blocks: string[];
  blockedBy: string[];
}

const TASKS_DIR = join(process.cwd(), ".tasks");

class TaskManager {
  private nextId = 1;

  constructor() {
    if (!existsSync(TASKS_DIR)) mkdirSync(TASKS_DIR, { recursive: true });
    const existing = this.listAll();
    if (existing.length > 0) {
      const maxId = Math.max(...existing.map((t) => parseInt(t.id) || 0));
      this.nextId = maxId + 1;
    }
  }

  private taskPath(id: string): string { return join(TASKS_DIR, `task_${id}.json`); }

  create(subject: string, description: string, blockedBy: string[] = []): Task {
    const id = String(this.nextId++);
    const task: Task = { id, subject, description, status: "pending", blocks: [], blockedBy: [...blockedBy] };
    // Update blocking tasks' blocks[] array
    for (const bid of blockedBy) {
      const blocker = this.get(bid);
      if (blocker && !blocker.blocks.includes(id)) {
        blocker.blocks.push(id);
        this.save(blocker);
      }
    }
    this.save(task);
    return task;
  }

  get(id: string): Task | null {
    const p = this.taskPath(id);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf-8"));
  }

  update(id: string, updates: Partial<Pick<Task, "status" | "description" | "owner">>): Task | null {
    const task = this.get(id);
    if (!task) return null;
    if (updates.status) task.status = updates.status;
    if (updates.description) task.description = updates.description;
    if (updates.owner !== undefined) task.owner = updates.owner;
    // When completed, clear this task from downstream blockedBy
    if (updates.status === "completed") this.clearDependency(id);
    this.save(task);
    return task;
  }

  listAll(): Task[] {
    if (!existsSync(TASKS_DIR)) return [];
    return readdirSync(TASKS_DIR)
      .filter((f) => f.startsWith("task_") && f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(TASKS_DIR, f), "utf-8")) as Task)
      .sort((a, b) => parseInt(a.id) - parseInt(b.id));
  }

  private clearDependency(completedId: string) {
    for (const task of this.listAll()) {
      const idx = task.blockedBy.indexOf(completedId);
      if (idx !== -1) {
        task.blockedBy.splice(idx, 1);
        this.save(task);
      }
    }
  }

  private save(task: Task) { writeFileSync(this.taskPath(task.id), JSON.stringify(task, null, 2)); }
}

const taskMgr = new TaskManager();

// ── Tool Handlers ─────────────────────────────────────────────────

type TH = (i: Record<string, unknown>) => string;
const H: Record<string, TH> = {
  Bash: (i) => { try { return execSync(i.command as string, { encoding: "utf-8", timeout: 30_000, cwd: process.cwd() }).slice(0, 15_000); } catch (e: unknown) { const err = e as { stdout?: string; stderr?: string; message?: string }; return [err.stdout, err.stderr, err.message].filter(Boolean).join("\n").slice(0, 15_000); } },
  Read: (i) => { try { const ls = readFileSync(resolve(i.file_path as string), "utf-8").split("\n"); const s = Math.max(0, ((i.offset as number) ?? 1) - 1); const e = i.limit ? s + (i.limit as number) : ls.length; return ls.slice(s, e).map((l, j) => `${String(s + j + 1).padStart(6)}|${l}`).join("\n") || "(empty)"; } catch (e: unknown) { return `Error: ${(e as Error).message}`; } },
  Write: (i) => { try { const p = resolve(i.file_path as string); if (!existsSync(dirname(p))) mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, i.content as string, "utf-8"); return `Written: ${p}`; } catch (e: unknown) { return `Error: ${(e as Error).message}`; } },
  Edit: (i) => { try { const p = resolve(i.file_path as string); const ct = readFileSync(p, "utf-8"); const old = i.old_string as string; const n = ct.split(old).length - 1; if (n === 0) return "Error: not found"; if (n > 1) return `Error: ${n} matches`; writeFileSync(p, ct.replace(old, i.new_string as string), "utf-8"); return `Edited: ${p}`; } catch (e: unknown) { return `Error: ${(e as Error).message}`; } },
  task_create: (i) => {
    const task = taskMgr.create(i.subject as string, i.description as string, (i.blocked_by as string[]) || []);
    return `Created task #${task.id}: ${task.subject}`;
  },
  task_update: (i) => {
    const task = taskMgr.update(i.id as string, { status: i.status as Task["status"], description: i.description as string | undefined, owner: i.owner as string | undefined });
    if (!task) return `Error: task ${i.id} not found`;
    return `Updated task #${task.id}: status=${task.status}${task.blockedBy.length > 0 ? ` (blocked by: ${task.blockedBy.join(",")})` : ""}`;
  },
  task_list: () => {
    const tasks = taskMgr.listAll();
    if (tasks.length === 0) return "No tasks";
    const icons: Record<string, string> = { pending: "○", in_progress: "◉", completed: "✓" };
    return tasks.map((t) => {
      let line = `${icons[t.status]} #${t.id} [${t.status}] ${t.subject}`;
      if (t.owner) line += ` (owner: ${t.owner})`;
      if (t.blockedBy.length > 0) line += ` [blocked by: ${t.blockedBy.join(",")}]`;
      return line;
    }).join("\n");
  },
  task_get: (i) => {
    const task = taskMgr.get(i.id as string);
    if (!task) return `Error: task ${i.id} not found`;
    return JSON.stringify(task, null, 2);
  },
};

const TOOLS: Anthropic.Tool[] = [
  { name: "Bash", description: "Run a shell command.", input_schema: { type: "object" as const, properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "Read", description: "Read a file.", input_schema: { type: "object" as const, properties: { file_path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } }, required: ["file_path"] } },
  { name: "Write", description: "Write a file.", input_schema: { type: "object" as const, properties: { file_path: { type: "string" }, content: { type: "string" } }, required: ["file_path", "content"] } },
  { name: "Edit", description: "Find-replace in file.", input_schema: { type: "object" as const, properties: { file_path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } }, required: ["file_path", "old_string", "new_string"] } },
  { name: "task_create", description: "Create a new task with optional dependencies.", input_schema: { type: "object" as const, properties: { subject: { type: "string" }, description: { type: "string" }, blocked_by: { type: "array", items: { type: "string" }, description: "IDs of tasks that must complete first" } }, required: ["subject", "description"] } },
  { name: "task_update", description: "Update a task's status, description, or owner.", input_schema: { type: "object" as const, properties: { id: { type: "string" }, status: { type: "string", enum: ["pending", "in_progress", "completed"] }, description: { type: "string" }, owner: { type: "string" } }, required: ["id"] } },
  { name: "task_list", description: "List all tasks with their status and dependencies.", input_schema: { type: "object" as const, properties: {}, required: [] } },
  { name: "task_get", description: "Get full details of a specific task.", input_schema: { type: "object" as const, properties: { id: { type: "string" } }, required: ["id"] } },
];

async function agentLoop(messages: Anthropic.MessageParam[]) {
  for (let turn = 0; turn < 50; turn++) {
    const resp = await client.messages.create({
      model: MODEL, max_tokens: 8192,
      system: "You are a coding assistant. Use task_create to break work into tasks with dependencies. Use task_update to track progress. Complete tasks in dependency order.",
      tools: TOOLS, messages,
    });
    for (const b of resp.content) if (b.type === "text") process.stdout.write(b.text);
    messages.push({ role: "assistant", content: resp.content });
    if (resp.stop_reason !== "tool_use") { console.log(); return; }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const b of resp.content) {
      if (b.type !== "tool_use") continue;
      const input = b.input as Record<string, unknown>;
      const label = b.name.startsWith("task_") ? `${b.name}(${input.id || input.subject || ""})` : b.name === "Bash" ? `$ ${input.command}` : String(input.file_path || "");
      console.log(`\n${c.cyan}[${b.name}]${c.reset} ${label}`);
      const output = (H[b.name] ?? (() => "Unknown tool"))(input);
      const preview = output.slice(0, 400);
      if (preview.trim()) console.log(`${c.dim}${preview}${output.length > 400 ? "..." : ""}${c.reset}`);
      results.push({ type: "tool_result", tool_use_id: b.id, content: output });
    }
    messages.push({ role: "user", content: results });
  }
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log("minicc s07 — Tasks (file-based task graph with DAG dependencies)");
  console.log(`${c.dim}Tasks stored in: ${TASKS_DIR}${c.reset}`);
  const messages: Anthropic.MessageParam[] = [];
  const ask = () => rl.question(`${c.green}>${c.reset} `, async (input) => {
    if (input.trim().toLowerCase() === "exit") return rl.close();
    if (input.trim().toLowerCase() === "tasks") { console.log(H.task_list({})); return ask(); }
    if (!input.trim()) return ask();
    messages.push({ role: "user", content: input });
    try { await agentLoop(messages); } catch (e: unknown) { console.error((e as Error).message); }
    ask();
  });
  ask();
}
main();
