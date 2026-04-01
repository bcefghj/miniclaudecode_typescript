#!/usr/bin/env npx tsx
/**
 * s08 — Background Tasks (~350 lines)
 *
 * Run slow operations in the background; the agent keeps thinking ahead.
 * Uses child_process.spawn for non-blocking execution with a notification queue.
 *
 * SOURCE MAPPING:
 *   tasks/LocalShellTask/LocalShellTask.tsx (522 lines) → BackgroundManager
 *   tools/BashTool/BashTool.tsx run_in_background → background_run tool
 *   Distillation ratio: ~700 lines → ~350 lines (2:1)
 */

import Anthropic from "@anthropic-ai/sdk";
import { execSync, spawn } from "child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname, resolve } from "path";
import * as readline from "readline";

const client = new Anthropic();
const MODEL = process.env.MINICC_MODEL || "claude-sonnet-4-20250514";
const c = { reset: "\x1b[0m", dim: "\x1b[90m", cyan: "\x1b[36m", green: "\x1b[32m", yellow: "\x1b[33m", blue: "\x1b[34m" };

// ── Background Manager ────────────────────────────────────────────

interface BgTask { id: string; command: string; status: "running" | "completed" | "failed"; result?: string; startedAt: number; }
interface Notification { taskId: string; status: string; command: string; result: string; }

class BackgroundManager {
  private tasks = new Map<string, BgTask>();
  private notifications: Notification[] = [];
  private nextId = 1;

  run(command: string): string {
    const id = `bg_${this.nextId++}`;
    const task: BgTask = { id, command, status: "running", startedAt: Date.now() };
    this.tasks.set(id, task);

    const child = spawn("bash", ["-c", command], {
      cwd: process.cwd(),
      env: { ...process.env, FORCE_COLOR: "0" },
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
    child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });

    child.on("close", (code) => {
      const result = (stdout + stderr).slice(0, 10_000) || `(exit code: ${code})`;
      task.status = code === 0 ? "completed" : "failed";
      task.result = result;
      this.notifications.push({ taskId: id, status: task.status, command, result });
      console.log(`\n${c.blue}[Background ${id} ${task.status}]${c.reset} ${command.slice(0, 60)}`);
    });

    child.on("error", (err) => {
      task.status = "failed";
      task.result = err.message;
      this.notifications.push({ taskId: id, status: "failed", command, result: err.message });
    });

    return `Started background task ${id}: ${command}`;
  }

  check(id: string): string {
    const task = this.tasks.get(id);
    if (!task) return `Error: task ${id} not found`;
    const elapsed = Math.round((Date.now() - task.startedAt) / 1000);
    let info = `${id}: ${task.status} (${elapsed}s) — ${task.command}`;
    if (task.result) info += `\nResult: ${task.result.slice(0, 2000)}`;
    return info;
  }

  listAll(): string {
    if (this.tasks.size === 0) return "No background tasks";
    return [...this.tasks.values()].map((t) => `${t.id} [${t.status}] ${t.command.slice(0, 60)}`).join("\n");
  }

  drainNotifications(): string | null {
    if (this.notifications.length === 0) return null;
    const msgs = this.notifications.map((n) =>
      `[Background task ${n.taskId} ${n.status}] ${n.command}\nResult: ${n.result.slice(0, 3000)}`
    ).join("\n\n");
    this.notifications.length = 0;
    return msgs;
  }
}

const bgMgr = new BackgroundManager();

// ── Tool Handlers ─────────────────────────────────────────────────

type TH = (i: Record<string, unknown>) => string;
const H: Record<string, TH> = {
  Bash: (i) => { try { return execSync(i.command as string, { encoding: "utf-8", timeout: 30_000, cwd: process.cwd() }).slice(0, 15_000); } catch (e: unknown) { const err = e as { stdout?: string; stderr?: string; message?: string }; return [err.stdout, err.stderr, err.message].filter(Boolean).join("\n").slice(0, 15_000); } },
  Read: (i) => { try { const ls = readFileSync(resolve(i.file_path as string), "utf-8").split("\n"); const s = Math.max(0, ((i.offset as number) ?? 1) - 1); const e = i.limit ? s + (i.limit as number) : ls.length; return ls.slice(s, e).map((l, j) => `${String(s + j + 1).padStart(6)}|${l}`).join("\n") || "(empty)"; } catch (e: unknown) { return `Error: ${(e as Error).message}`; } },
  Write: (i) => { try { const p = resolve(i.file_path as string); if (!existsSync(dirname(p))) mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, i.content as string, "utf-8"); return `Written: ${p}`; } catch (e: unknown) { return `Error: ${(e as Error).message}`; } },
  Edit: (i) => { try { const p = resolve(i.file_path as string); const ct = readFileSync(p, "utf-8"); const old = i.old_string as string; const n = ct.split(old).length - 1; if (n === 0) return "Error: not found"; if (n > 1) return `Error: ${n} matches`; writeFileSync(p, ct.replace(old, i.new_string as string), "utf-8"); return `Edited: ${p}`; } catch (e: unknown) { return `Error: ${(e as Error).message}`; } },
  background_run: (i) => bgMgr.run(i.command as string),
  check_background: (i) => i.id ? bgMgr.check(i.id as string) : bgMgr.listAll(),
};

const TOOLS: Anthropic.Tool[] = [
  { name: "Bash", description: "Run a shell command (blocking).", input_schema: { type: "object" as const, properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "Read", description: "Read a file.", input_schema: { type: "object" as const, properties: { file_path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } }, required: ["file_path"] } },
  { name: "Write", description: "Write a file.", input_schema: { type: "object" as const, properties: { file_path: { type: "string" }, content: { type: "string" } }, required: ["file_path", "content"] } },
  { name: "Edit", description: "Find-replace in file.", input_schema: { type: "object" as const, properties: { file_path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } }, required: ["file_path", "old_string", "new_string"] } },
  { name: "background_run", description: "Run a command in the background (non-blocking). Use for slow operations like npm install, tests, builds.", input_schema: { type: "object" as const, properties: { command: { type: "string", description: "Command to run in background" } }, required: ["command"] } },
  { name: "check_background", description: "Check status of background tasks.", input_schema: { type: "object" as const, properties: { id: { type: "string", description: "Task ID to check (omit to list all)" } }, required: [] } },
];

async function agentLoop(messages: Anthropic.MessageParam[]) {
  for (let turn = 0; turn < 50; turn++) {
    // Drain background notifications and inject into context
    const notifications = bgMgr.drainNotifications();
    if (notifications) {
      messages.push({ role: "user", content: `[System notification]\n${notifications}` });
    }

    const resp = await client.messages.create({
      model: MODEL, max_tokens: 8192,
      system: "You are a coding assistant. Use background_run for slow operations (npm install, tests, builds). Use check_background to poll results. The agent loop automatically injects results when background tasks complete.",
      tools: TOOLS, messages,
    });
    for (const b of resp.content) if (b.type === "text") process.stdout.write(b.text);
    messages.push({ role: "assistant", content: resp.content });
    if (resp.stop_reason !== "tool_use") { console.log(); return; }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const b of resp.content) {
      if (b.type !== "tool_use") continue;
      const input = b.input as Record<string, unknown>;
      const label = b.name === "Bash" || b.name === "background_run" ? `$ ${input.command}` : String(input.file_path || input.id || b.name);
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
  console.log("minicc s08 — Background Tasks (non-blocking execution)");
  const messages: Anthropic.MessageParam[] = [];
  const ask = () => rl.question(`${c.green}>${c.reset} `, async (input) => {
    if (input.trim().toLowerCase() === "exit") return rl.close();
    if (input.trim().toLowerCase() === "bg") { console.log(bgMgr.listAll()); return ask(); }
    if (!input.trim()) return ask();
    messages.push({ role: "user", content: input });
    try { await agentLoop(messages); } catch (e: unknown) { console.error((e as Error).message); }
    ask();
  });
  ask();
}
main();
