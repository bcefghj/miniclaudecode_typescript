#!/usr/bin/env npx tsx
/**
 * s12 — Worktree + Task Isolation (~550 lines)
 *
 * Each agent works in its own git worktree directory.
 * Tasks manage goals, worktrees manage directories, bound by task_id.
 *
 * SOURCE MAPPING:
 *   utils/worktree.ts (1519 lines) → WorktreeManager here
 *   tools/EnterWorktreeTool/ (127 lines) → worktree_create tool
 *   tools/ExitWorktreeTool/ (~300 lines) → worktree_remove tool
 *   Distillation ratio: 1946 lines → ~550 lines (3.5:1)
 */

import Anthropic from "@anthropic-ai/sdk";
import { execSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync, readdirSync } from "fs";
import { dirname, resolve, join } from "path";
import * as readline from "readline";

const client = new Anthropic();
const MODEL = process.env.MINICC_MODEL || "claude-sonnet-4-20250514";
const c = { reset: "\x1b[0m", dim: "\x1b[90m", cyan: "\x1b[36m", green: "\x1b[32m", magenta: "\x1b[35m", blue: "\x1b[34m", yellow: "\x1b[33m" };

const TASKS_DIR = join(process.cwd(), ".tasks");
const WORKTREE_DIR = join(process.cwd(), ".worktrees");

// ── Task Manager ──────────────────────────────────────────────────
interface Task { id: string; subject: string; description: string; status: "pending" | "in_progress" | "completed"; owner?: string; worktree?: string; blocks: string[]; blockedBy: string[]; }

class TaskManager {
  private nextId = 1;
  constructor() { if (!existsSync(TASKS_DIR)) mkdirSync(TASKS_DIR, { recursive: true }); const all = this.listAll(); if (all.length > 0) this.nextId = Math.max(...all.map((t) => parseInt(t.id) || 0)) + 1; }
  private path(id: string) { return join(TASKS_DIR, `task_${id}.json`); }
  create(subject: string, description: string, blockedBy: string[] = []): Task {
    const id = String(this.nextId++);
    const task: Task = { id, subject, description, status: "pending", blocks: [], blockedBy: [...blockedBy] };
    for (const bid of blockedBy) { const b = this.get(bid); if (b && !b.blocks.includes(id)) { b.blocks.push(id); this.save(b); } }
    this.save(task); return task;
  }
  get(id: string): Task | null { return existsSync(this.path(id)) ? JSON.parse(readFileSync(this.path(id), "utf-8")) : null; }
  update(id: string, u: Partial<Pick<Task, "status" | "owner" | "worktree">>): Task | null {
    const t = this.get(id); if (!t) return null;
    if (u.status) t.status = u.status; if (u.owner !== undefined) t.owner = u.owner; if (u.worktree !== undefined) t.worktree = u.worktree;
    if (u.status === "completed") { for (const other of this.listAll()) { const idx = other.blockedBy.indexOf(id); if (idx !== -1) { other.blockedBy.splice(idx, 1); this.save(other); } } }
    this.save(t); return t;
  }
  listAll(): Task[] { return existsSync(TASKS_DIR) ? readdirSync(TASKS_DIR).filter((f) => f.startsWith("task_") && f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(TASKS_DIR, f), "utf-8")) as Task).sort((a, b) => parseInt(a.id) - parseInt(b.id)) : []; }
  format(): string { const all = this.listAll(); if (all.length === 0) return "No tasks"; return all.map((t) => `${{ pending: "○", in_progress: "◉", completed: "✓" }[t.status]} #${t.id} ${t.subject}${t.owner ? ` (${t.owner})` : ""}${t.worktree ? ` [wt:${t.worktree}]` : ""}${t.blockedBy.length > 0 ? ` [blocked]` : ""}`).join("\n"); }
  private save(t: Task) { writeFileSync(this.path(t.id), JSON.stringify(t, null, 2)); }
}
const taskMgr = new TaskManager();

// ── Event Bus ─────────────────────────────────────────────────────
function emitEvent(event: string, data: Record<string, unknown>) {
  if (!existsSync(WORKTREE_DIR)) mkdirSync(WORKTREE_DIR, { recursive: true });
  appendFileSync(join(WORKTREE_DIR, "events.jsonl"), JSON.stringify({ event, timestamp: Date.now(), ...data }) + "\n");
}

// ── Worktree Manager ──────────────────────────────────────────────
interface WorktreeEntry { name: string; path: string; branch: string; taskId?: string; status: "active" | "removed"; }
interface WorktreeIndex { worktrees: WorktreeEntry[]; }

function detectRepoRoot(): string {
  try { return execSync("git rev-parse --show-toplevel", { encoding: "utf-8", cwd: process.cwd() }).trim(); }
  catch { return process.cwd(); }
}

class WorktreeManager {
  private index: WorktreeIndex = { worktrees: [] };
  private indexPath = join(WORKTREE_DIR, "index.json");
  private repoRoot = detectRepoRoot();

  constructor() {
    if (!existsSync(WORKTREE_DIR)) mkdirSync(WORKTREE_DIR, { recursive: true });
    if (existsSync(this.indexPath)) this.index = JSON.parse(readFileSync(this.indexPath, "utf-8"));
  }

  create(name: string, taskId?: string): string {
    if (this.index.worktrees.find((w) => w.name === name && w.status === "active")) return `Worktree ${name} already exists`;

    const branch = `wt/${name}`;
    const wtPath = join(this.repoRoot, ".worktrees", name);

    try {
      // Get current branch as base
      const baseRef = execSync("git rev-parse HEAD", { encoding: "utf-8", cwd: this.repoRoot }).trim();
      execSync(`git worktree add -b "${branch}" "${wtPath}" "${baseRef}"`, { encoding: "utf-8", cwd: this.repoRoot });

      const entry: WorktreeEntry = { name, path: wtPath, branch, taskId, status: "active" };
      this.index.worktrees.push(entry);
      this.saveIndex();

      // Bind to task if specified
      if (taskId) {
        taskMgr.update(taskId, { worktree: name, status: "in_progress" });
      }

      emitEvent("worktree_created", { name, path: wtPath, taskId });
      return `Created worktree "${name}" at ${wtPath}${taskId ? ` (bound to task #${taskId})` : ""}`;
    } catch (e: unknown) {
      return `Error creating worktree: ${(e as Error).message}`;
    }
  }

  run(name: string, command: string): string {
    const wt = this.index.worktrees.find((w) => w.name === name && w.status === "active");
    if (!wt) return `Worktree ${name} not found`;
    try {
      return execSync(command, { encoding: "utf-8", timeout: 30_000, cwd: wt.path }).slice(0, 15_000);
    } catch (e: unknown) {
      const err = e as { stdout?: string; stderr?: string; message?: string };
      return [err.stdout, err.stderr, err.message].filter(Boolean).join("\n").slice(0, 15_000);
    }
  }

  remove(name: string, completeTask?: boolean): string {
    const wt = this.index.worktrees.find((w) => w.name === name && w.status === "active");
    if (!wt) return `Worktree ${name} not found`;

    try {
      execSync(`git worktree remove "${wt.path}" --force`, { encoding: "utf-8", cwd: this.repoRoot });
      // Clean up branch
      try { execSync(`git branch -D "${wt.branch}"`, { encoding: "utf-8", cwd: this.repoRoot }); } catch {}
    } catch (e: unknown) {
      return `Error removing: ${(e as Error).message}`;
    }

    wt.status = "removed";
    this.saveIndex();

    if (completeTask && wt.taskId) {
      taskMgr.update(wt.taskId, { status: "completed" });
    }

    emitEvent("worktree_removed", { name, taskId: wt.taskId, completed: completeTask });
    return `Removed worktree "${name}"${completeTask && wt.taskId ? ` and completed task #${wt.taskId}` : ""}`;
  }

  list(): string {
    const active = this.index.worktrees.filter((w) => w.status === "active");
    if (active.length === 0) return "No active worktrees";
    return active.map((w) => `◉ ${w.name} → ${w.path}${w.taskId ? ` (task #${w.taskId})` : ""}`).join("\n");
  }

  private saveIndex() { writeFileSync(this.indexPath, JSON.stringify(this.index, null, 2)); }
}

let wtMgr: WorktreeManager;
try { wtMgr = new WorktreeManager(); } catch { wtMgr = new WorktreeManager(); }

// ── Tool Handlers ─────────────────────────────────────────────────
type TH = (i: Record<string, unknown>) => string;
const H: Record<string, TH> = {
  Bash: (i) => { try { return execSync(i.command as string, { encoding: "utf-8", timeout: 30_000, cwd: process.cwd() }).slice(0, 15_000); } catch (e: unknown) { const err = e as { stdout?: string; stderr?: string; message?: string }; return [err.stdout, err.stderr, err.message].filter(Boolean).join("\n").slice(0, 15_000); } },
  Read: (i) => { try { return readFileSync(resolve(i.file_path as string), "utf-8").split("\n").map((l, j) => `${String(j + 1).padStart(6)}|${l}`).join("\n") || "(empty)"; } catch (e: unknown) { return `Error: ${(e as Error).message}`; } },
  Write: (i) => { try { const p = resolve(i.file_path as string); if (!existsSync(dirname(p))) mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, i.content as string, "utf-8"); return `Written: ${p}`; } catch (e: unknown) { return `Error: ${(e as Error).message}`; } },
  Edit: (i) => { try { const p = resolve(i.file_path as string); const ct = readFileSync(p, "utf-8"); const old = i.old_string as string; const n = ct.split(old).length - 1; if (n === 0) return "not found"; if (n > 1) return `${n} matches`; writeFileSync(p, ct.replace(old, i.new_string as string), "utf-8"); return `Edited: ${p}`; } catch (e: unknown) { return `Error: ${(e as Error).message}`; } },
  task_create: (i) => { const t = taskMgr.create(i.subject as string, i.description as string, (i.blocked_by as string[]) || []); return `Created #${t.id}: ${t.subject}`; },
  task_update: (i) => { const t = taskMgr.update(i.id as string, { status: i.status as Task["status"] }); return t ? `Updated #${t.id} → ${t.status}` : "Not found"; },
  task_list: () => taskMgr.format(),
  worktree_create: (i) => wtMgr.create(i.name as string, i.task_id as string | undefined),
  worktree_run: (i) => wtMgr.run(i.name as string, i.command as string),
  worktree_remove: (i) => wtMgr.remove(i.name as string, i.complete_task as boolean | undefined),
  worktree_list: () => wtMgr.list(),
};

const TOOLS: Anthropic.Tool[] = [
  { name: "Bash", description: "Run command in main directory.", input_schema: { type: "object" as const, properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "Read", description: "Read file.", input_schema: { type: "object" as const, properties: { file_path: { type: "string" } }, required: ["file_path"] } },
  { name: "Write", description: "Write file.", input_schema: { type: "object" as const, properties: { file_path: { type: "string" }, content: { type: "string" } }, required: ["file_path", "content"] } },
  { name: "Edit", description: "Edit file.", input_schema: { type: "object" as const, properties: { file_path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } }, required: ["file_path", "old_string", "new_string"] } },
  { name: "task_create", description: "Create a task.", input_schema: { type: "object" as const, properties: { subject: { type: "string" }, description: { type: "string" }, blocked_by: { type: "array", items: { type: "string" } } }, required: ["subject", "description"] } },
  { name: "task_update", description: "Update task status.", input_schema: { type: "object" as const, properties: { id: { type: "string" }, status: { type: "string", enum: ["pending", "in_progress", "completed"] } }, required: ["id"] } },
  { name: "task_list", description: "List all tasks.", input_schema: { type: "object" as const, properties: {}, required: [] } },
  { name: "worktree_create", description: "Create a git worktree for isolated work. Optionally bind to a task.", input_schema: { type: "object" as const, properties: { name: { type: "string", description: "Worktree name (alphanumeric)" }, task_id: { type: "string", description: "Task to bind to (sets task to in_progress)" } }, required: ["name"] } },
  { name: "worktree_run", description: "Run a command inside a specific worktree's directory.", input_schema: { type: "object" as const, properties: { name: { type: "string" }, command: { type: "string" } }, required: ["name", "command"] } },
  { name: "worktree_remove", description: "Remove a worktree. Optionally complete the bound task.", input_schema: { type: "object" as const, properties: { name: { type: "string" }, complete_task: { type: "boolean", description: "If true, mark bound task as completed" } }, required: ["name"] } },
  { name: "worktree_list", description: "List active worktrees.", input_schema: { type: "object" as const, properties: {}, required: [] } },
];

async function agentLoop(messages: Anthropic.MessageParam[]) {
  for (let turn = 0; turn < 50; turn++) {
    const resp = await client.messages.create({
      model: MODEL, max_tokens: 8192,
      system: "You are a coding assistant. Use worktree_create to isolate work for each task in its own git worktree. Use worktree_run to execute commands inside worktrees. Use task_create for planning, worktree_create to bind tasks to isolated directories.",
      tools: TOOLS, messages,
    });
    for (const b of resp.content) if (b.type === "text") process.stdout.write(b.text);
    messages.push({ role: "assistant", content: resp.content });
    if (resp.stop_reason !== "tool_use") { console.log(); return; }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const b of resp.content) {
      if (b.type !== "tool_use") continue;
      const input = b.input as Record<string, unknown>;
      const label = b.name.startsWith("worktree_") || b.name.startsWith("task_") ? `${b.name}(${input.name || input.id || input.subject || ""})` : b.name === "Bash" ? `$ ${input.command}` : String(input.file_path || b.name);
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
  console.log("minicc s12 — Worktree + Task Isolation (git worktrees for parallel work)");
  console.log(`${c.dim}Repo root: ${detectRepoRoot()}${c.reset}`);
  const messages: Anthropic.MessageParam[] = [];
  const ask = () => rl.question(`${c.green}>${c.reset} `, async (input) => {
    if (input.trim().toLowerCase() === "exit") return rl.close();
    if (input.trim().toLowerCase() === "tasks") { console.log(taskMgr.format()); return ask(); }
    if (input.trim().toLowerCase() === "wt") { console.log(wtMgr.list()); return ask(); }
    if (!input.trim()) return ask();
    messages.push({ role: "user", content: input });
    try { await agentLoop(messages); } catch (e: unknown) { console.error((e as Error).message); }
    ask();
  });
  ask();
}
main();
