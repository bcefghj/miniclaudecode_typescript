#!/usr/bin/env npx tsx
/**
 * s11 — Autonomous Agents (~500 lines)
 *
 * Teammates scan the board and claim tasks themselves; no need for the lead to assign.
 * State machine: WORK → IDLE → SCAN → CLAIM → WORK
 * Identity preservation after context compaction.
 *
 * SOURCE MAPPING:
 *   utils/swarm/ autonomous task claiming logic
 *   utils/tasks.ts owner field + claim lock
 *   Distilled: file-lock claiming + idle scan loop
 */

import Anthropic from "@anthropic-ai/sdk";
import { execSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync, readdirSync, unlinkSync } from "fs";
import { dirname, resolve, join } from "path";
import * as readline from "readline";
import { randomUUID } from "crypto";

const client = new Anthropic();
const MODEL = process.env.MINICC_MODEL || "claude-sonnet-4-20250514";
const c = { reset: "\x1b[0m", dim: "\x1b[90m", cyan: "\x1b[36m", green: "\x1b[32m", magenta: "\x1b[35m", blue: "\x1b[34m", yellow: "\x1b[33m" };

const TEAM_DIR = join(process.cwd(), ".team");
const INBOX_DIR = join(TEAM_DIR, "inbox");
const TASKS_DIR = join(process.cwd(), ".tasks");
const IDLE_TIMEOUT = 15_000;
const POLL_INTERVAL = 3_000;

// ── Task Manager ──────────────────────────────────────────────────
interface Task { id: string; subject: string; description: string; status: "pending" | "in_progress" | "completed"; owner?: string; blocks: string[]; blockedBy: string[]; }

class TaskManager {
  private nextId = 1;
  constructor() {
    if (!existsSync(TASKS_DIR)) mkdirSync(TASKS_DIR, { recursive: true });
    const all = this.listAll();
    if (all.length > 0) this.nextId = Math.max(...all.map((t) => parseInt(t.id) || 0)) + 1;
  }
  private path(id: string) { return join(TASKS_DIR, `task_${id}.json`); }
  create(subject: string, description: string, blockedBy: string[] = []): Task {
    const id = String(this.nextId++);
    const task: Task = { id, subject, description, status: "pending", blocks: [], blockedBy: [...blockedBy] };
    for (const bid of blockedBy) { const b = this.get(bid); if (b && !b.blocks.includes(id)) { b.blocks.push(id); this.save(b); } }
    this.save(task); return task;
  }
  get(id: string): Task | null { const p = this.path(id); return existsSync(p) ? JSON.parse(readFileSync(p, "utf-8")) : null; }
  update(id: string, u: Partial<Pick<Task, "status" | "owner">>): Task | null {
    const t = this.get(id); if (!t) return null;
    if (u.status) t.status = u.status; if (u.owner !== undefined) t.owner = u.owner;
    if (u.status === "completed") { for (const other of this.listAll()) { const idx = other.blockedBy.indexOf(id); if (idx !== -1) { other.blockedBy.splice(idx, 1); this.save(other); } } }
    this.save(t); return t;
  }
  listAll(): Task[] { return existsSync(TASKS_DIR) ? readdirSync(TASKS_DIR).filter((f) => f.startsWith("task_") && f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(TASKS_DIR, f), "utf-8")) as Task).sort((a, b) => parseInt(a.id) - parseInt(b.id)) : []; }
  scanUnclaimed(): Task[] { return this.listAll().filter((t) => t.status === "pending" && !t.owner && t.blockedBy.length === 0); }
  claim(id: string, owner: string): boolean {
    const lockFile = join(TASKS_DIR, `_claim_lock`);
    if (existsSync(lockFile)) return false;
    try {
      writeFileSync(lockFile, owner);
      const t = this.get(id);
      if (!t || t.owner || t.status !== "pending") { try { unlinkSync(lockFile); } catch {} return false; }
      t.owner = owner; t.status = "in_progress"; this.save(t);
      try { unlinkSync(lockFile); } catch {}
      return true;
    } catch { try { unlinkSync(lockFile); } catch {} return false; }
  }
  private save(t: Task) { writeFileSync(this.path(t.id), JSON.stringify(t, null, 2)); }
  format(): string { const all = this.listAll(); if (all.length === 0) return "No tasks"; return all.map((t) => `${{ pending: "○", in_progress: "◉", completed: "✓" }[t.status]} #${t.id} ${t.subject}${t.owner ? ` (${t.owner})` : ""}${t.blockedBy.length > 0 ? ` [blocked]` : ""}`).join("\n"); }
}
const taskMgr = new TaskManager();

// ── MessageBus ────────────────────────────────────────────────────
interface TeamMessage { type: string; from: string; content: string; timestamp: number; extra?: Record<string, unknown>; }
class MessageBus {
  constructor() { if (!existsSync(INBOX_DIR)) mkdirSync(INBOX_DIR, { recursive: true }); }
  send(to: string, msg: TeamMessage) { appendFileSync(join(INBOX_DIR, `${to}.jsonl`), JSON.stringify(msg) + "\n"); }
  readInbox(name: string): TeamMessage[] { const p = join(INBOX_DIR, `${name}.jsonl`); if (!existsSync(p)) return []; const lines = readFileSync(p, "utf-8").trim().split("\n").filter(Boolean); writeFileSync(p, ""); return lines.map((l) => JSON.parse(l)); }
}
const bus = new MessageBus();

// ── Tool Handlers ─────────────────────────────────────────────────
type TH = (i: Record<string, unknown>) => string;
const H: Record<string, TH> = {
  Bash: (i) => { try { return execSync(i.command as string, { encoding: "utf-8", timeout: 30_000, cwd: process.cwd() }).slice(0, 15_000); } catch (e: unknown) { const err = e as { stdout?: string; stderr?: string; message?: string }; return [err.stdout, err.stderr, err.message].filter(Boolean).join("\n").slice(0, 15_000); } },
  Read: (i) => { try { return readFileSync(resolve(i.file_path as string), "utf-8").split("\n").map((l, j) => `${String(j + 1).padStart(6)}|${l}`).join("\n") || "(empty)"; } catch (e: unknown) { return `Error: ${(e as Error).message}`; } },
  Write: (i) => { try { const p = resolve(i.file_path as string); if (!existsSync(dirname(p))) mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, i.content as string, "utf-8"); return `Written: ${p}`; } catch (e: unknown) { return `Error: ${(e as Error).message}`; } },
  Edit: (i) => { try { const p = resolve(i.file_path as string); const ct = readFileSync(p, "utf-8"); const old = i.old_string as string; const n = ct.split(old).length - 1; if (n === 0) return "not found"; if (n > 1) return `${n} matches`; writeFileSync(p, ct.replace(old, i.new_string as string), "utf-8"); return `Edited: ${p}`; } catch (e: unknown) { return `Error: ${(e as Error).message}`; } },
};

const TOOLS: Anthropic.Tool[] = [
  { name: "Bash", description: "Run command.", input_schema: { type: "object" as const, properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "Read", description: "Read file.", input_schema: { type: "object" as const, properties: { file_path: { type: "string" } }, required: ["file_path"] } },
  { name: "Write", description: "Write file.", input_schema: { type: "object" as const, properties: { file_path: { type: "string" }, content: { type: "string" } }, required: ["file_path", "content"] } },
  { name: "Edit", description: "Edit file.", input_schema: { type: "object" as const, properties: { file_path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } }, required: ["file_path", "old_string", "new_string"] } },
  { name: "send_message", description: "Send message.", input_schema: { type: "object" as const, properties: { to: { type: "string" }, content: { type: "string" } }, required: ["content"] } },
  { name: "idle", description: "Signal that current work is done; enter idle state to scan for new tasks.", input_schema: { type: "object" as const, properties: {}, required: [] } },
  { name: "task_create", description: "Create task.", input_schema: { type: "object" as const, properties: { subject: { type: "string" }, description: { type: "string" }, blocked_by: { type: "array", items: { type: "string" } } }, required: ["subject", "description"] } },
  { name: "task_update", description: "Update task.", input_schema: { type: "object" as const, properties: { id: { type: "string" }, status: { type: "string", enum: ["pending", "in_progress", "completed"] } }, required: ["id"] } },
  { name: "task_list", description: "List tasks.", input_schema: { type: "object" as const, properties: {}, required: [] } },
  { name: "team_spawn", description: "Spawn autonomous teammate.", input_schema: { type: "object" as const, properties: { name: { type: "string" }, role: { type: "string" } }, required: ["name", "role"] } },
];

// ── Autonomous Teammate Loop ──────────────────────────────────────
async function autonomousLoop(name: string, role: string) {
  console.log(`${c.magenta}[${name}] Starting autonomous loop${c.reset}`);
  let msgs: Anthropic.MessageParam[] = [];

  outerLoop: while (true) {
    // WORK phase
    for (let turn = 0; turn < 30; turn++) {
      const inbox = bus.readInbox(name);
      if (inbox.length > 0) msgs.push({ role: "user", content: inbox.map((m) => `[${m.type} from ${m.from}] ${m.content}`).join("\n") });
      else if (msgs.length === 0) { await new Promise((r) => setTimeout(r, 1000)); continue; }

      // Identity preservation after compact
      if (msgs.length <= 3) {
        msgs.unshift({ role: "user", content: `You are "${name}", an autonomous teammate with role: ${role}. Scan for unclaimed tasks and work on them.` });
        msgs.push({ role: "assistant", content: `I'm ${name}. I'll scan for tasks and work autonomously.` });
      }

      const resp = await client.messages.create({ model: MODEL, max_tokens: 4096, system: `You are "${name}" (${role}). Work autonomously: claim unclaimed tasks, complete them, then call idle. Communicate results via send_message.`, tools: TOOLS, messages: msgs });
      let text = ""; for (const b of resp.content) if (b.type === "text") text += b.text;
      if (text) console.log(`${c.blue}[${name}]${c.reset} ${text.slice(0, 200)}`);
      msgs.push({ role: "assistant", content: resp.content });
      if (resp.stop_reason !== "tool_use") break;

      let wentIdle = false;
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const b of resp.content) {
        if (b.type !== "tool_use") continue;
        const input = b.input as Record<string, unknown>;
        let output: string;
        if (b.name === "idle") { wentIdle = true; output = "Entering idle state. Will scan for unclaimed tasks."; }
        else if (b.name === "send_message") { bus.send((input.to as string) || "lead", { type: "message", from: name, content: input.content as string, timestamp: Date.now() }); output = "Sent"; }
        else if (b.name === "task_create") { const t = taskMgr.create(input.subject as string, input.description as string, (input.blocked_by as string[]) || []); output = `Created #${t.id}`; }
        else if (b.name === "task_update") { const t = taskMgr.update(input.id as string, { status: input.status as Task["status"] }); output = t ? `Updated #${t.id} → ${t.status}` : "Not found"; }
        else if (b.name === "task_list") { output = taskMgr.format(); }
        else { output = (H[b.name] ?? (() => "Unknown"))(input); }
        results.push({ type: "tool_result", tool_use_id: b.id, content: output });
      }
      msgs.push({ role: "user", content: results });
      if (wentIdle) break;
    }

    // IDLE phase: scan for unclaimed tasks
    let idleTime = 0;
    while (idleTime < IDLE_TIMEOUT) {
      const unclaimed = taskMgr.scanUnclaimed();
      if (unclaimed.length > 0) {
        const task = unclaimed[0];
        if (taskMgr.claim(task.id, name)) {
          console.log(`${c.green}[${name}] Claimed task #${task.id}: ${task.subject}${c.reset}`);
          msgs.push({ role: "user", content: `[Auto-claimed task #${task.id}] ${task.subject}: ${task.description}` });
          continue outerLoop; // Back to WORK
        }
      }
      // Check inbox
      const inbox = bus.readInbox(name);
      if (inbox.length > 0) {
        msgs.push({ role: "user", content: inbox.map((m) => `[${m.type} from ${m.from}] ${m.content}`).join("\n") });
        continue outerLoop;
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL));
      idleTime += POLL_INTERVAL;
    }
    console.log(`${c.dim}[${name}] Idle timeout reached, shutting down${c.reset}`);
    break;
  }
}

// ── Lead Agent Loop ───────────────────────────────────────────────
async function agentLoop(messages: Anthropic.MessageParam[]) {
  for (let turn = 0; turn < 50; turn++) {
    const inbox = bus.readInbox("lead");
    if (inbox.length > 0) messages.push({ role: "user", content: `[Messages]\n${inbox.map((m) => `[${m.from}] ${m.content}`).join("\n")}` });

    const resp = await client.messages.create({ model: MODEL, max_tokens: 8192, system: "You are the lead. Create tasks with task_create. Spawn autonomous teammates with team_spawn — they auto-claim tasks.", tools: TOOLS, messages });
    for (const b of resp.content) if (b.type === "text") process.stdout.write(b.text);
    messages.push({ role: "assistant", content: resp.content });
    if (resp.stop_reason !== "tool_use") { console.log(); return; }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const b of resp.content) {
      if (b.type !== "tool_use") continue;
      const input = b.input as Record<string, unknown>;
      let output: string;
      if (b.name === "team_spawn") { autonomousLoop(input.name as string, input.role as string); output = `Spawned autonomous agent: ${input.name}`; }
      else if (b.name === "task_create") { const t = taskMgr.create(input.subject as string, input.description as string, (input.blocked_by as string[]) || []); output = `Created #${t.id}: ${t.subject}`; }
      else if (b.name === "task_update") { const t = taskMgr.update(input.id as string, { status: input.status as Task["status"] }); output = t ? `Updated #${t.id}` : "Not found"; }
      else if (b.name === "task_list") { output = taskMgr.format(); }
      else if (b.name === "send_message") { bus.send(input.to as string, { type: "message", from: "lead", content: input.content as string, timestamp: Date.now() }); output = "Sent"; }
      else { output = (H[b.name] ?? (() => "Unknown"))(input); }
      console.log(`\n${c.cyan}[${b.name}]${c.reset} ${JSON.stringify(input).slice(0, 80)}`);
      const preview = output.slice(0, 300); if (preview.trim()) console.log(`${c.dim}${preview}${c.reset}`);
      results.push({ type: "tool_result", tool_use_id: b.id, content: output });
    }
    messages.push({ role: "user", content: results });
  }
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log("minicc s11 — Autonomous Agents (self-claiming tasks)");
  const messages: Anthropic.MessageParam[] = [];
  const ask = () => rl.question(`${c.green}>${c.reset} `, async (input) => {
    if (input.trim().toLowerCase() === "exit") return rl.close();
    if (input.trim().toLowerCase() === "tasks") { console.log(taskMgr.format()); return ask(); }
    if (!input.trim()) return ask();
    messages.push({ role: "user", content: input });
    try { await agentLoop(messages); } catch (e: unknown) { console.error((e as Error).message); }
    ask();
  });
  ask();
}
main();
