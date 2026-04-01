#!/usr/bin/env npx tsx
/**
 * s10 — Team Protocols (~450 lines)
 *
 * One request-response pattern drives all team negotiation.
 * Shutdown requests, plan approvals — all use request_id correlation.
 *
 * SOURCE MAPPING:
 *   coordinator/coordinatorMode.ts (369 lines) → protocol patterns
 *   utils/swarm/ permission bridge, leader bridge → request tracking
 *   Distillation: request_id + pending/approved/rejected state machine
 */

import Anthropic from "@anthropic-ai/sdk";
import { execSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from "fs";
import { dirname, resolve, join } from "path";
import * as readline from "readline";
import { randomUUID } from "crypto";

const client = new Anthropic();
const MODEL = process.env.MINICC_MODEL || "claude-sonnet-4-20250514";
const c = { reset: "\x1b[0m", dim: "\x1b[90m", cyan: "\x1b[36m", green: "\x1b[32m", magenta: "\x1b[35m", blue: "\x1b[34m", yellow: "\x1b[33m" };

const TEAM_DIR = join(process.cwd(), ".team");
const INBOX_DIR = join(TEAM_DIR, "inbox");

// ── Protocol Tracker ──────────────────────────────────────────────
interface ProtocolRequest { id: string; type: "shutdown" | "plan_approval"; from: string; target?: string; plan?: string; status: "pending" | "approved" | "rejected"; feedback?: string; }
const protocolTracker = new Map<string, ProtocolRequest>();

// ── Message Bus ───────────────────────────────────────────────────
interface TeamMessage { type: string; from: string; content: string; timestamp: number; extra?: Record<string, unknown>; }

class MessageBus {
  constructor() { if (!existsSync(INBOX_DIR)) mkdirSync(INBOX_DIR, { recursive: true }); }
  send(to: string, msg: TeamMessage) { appendFileSync(join(INBOX_DIR, `${to}.jsonl`), JSON.stringify(msg) + "\n"); }
  readInbox(name: string): TeamMessage[] {
    const p = join(INBOX_DIR, `${name}.jsonl`);
    if (!existsSync(p)) return [];
    const lines = readFileSync(p, "utf-8").trim().split("\n").filter(Boolean);
    writeFileSync(p, "");
    return lines.map((l) => JSON.parse(l));
  }
}
const bus = new MessageBus();

// ── Teammate Manager with Protocols ───────────────────────────────
interface TeamConfig { members: { name: string; role: string; status: string }[]; }

class TeammateManager {
  private config: TeamConfig = { members: [] };

  constructor() {
    const cp = join(TEAM_DIR, "config.json");
    if (existsSync(cp)) this.config = JSON.parse(readFileSync(cp, "utf-8"));
  }

  spawn(name: string, role: string, task: string): string {
    if (this.config.members.find((m) => m.name === name)) return `${name} already exists`;
    this.config.members.push({ name, role, status: "active" });
    this.saveConfig();
    bus.send(name, { type: "task", from: "lead", content: task, timestamp: Date.now() });
    this.runTeammateLoop(name, role);
    return `Spawned ${name} (${role})`;
  }

  private async runTeammateLoop(name: string, role: string) {
    const msgs: Anthropic.MessageParam[] = [];
    let shouldExit = false;

    for (let turn = 0; turn < 30 && !shouldExit; turn++) {
      const inbox = bus.readInbox(name);
      if (inbox.length === 0 && msgs.length === 0) { await new Promise((r) => setTimeout(r, 1000)); continue; }
      if (inbox.length === 0 && msgs.length > 0) break;

      // Process protocol messages
      for (const msg of inbox) {
        if (msg.type === "shutdown_request" && msg.extra) {
          const reqId = msg.extra.request_id as string;
          console.log(`${c.yellow}[${name}] Received shutdown request ${reqId}${c.reset}`);
          bus.send("lead", { type: "shutdown_response", from: name, content: "Approved", timestamp: Date.now(), extra: { request_id: reqId, approve: true } });
          shouldExit = true;
        }
      }

      const inboxText = inbox.map((m) => `[${m.type} from ${m.from}] ${m.content}`).join("\n");
      msgs.push({ role: "user", content: inboxText });

      if (shouldExit) break;

      const resp = await client.messages.create({
        model: MODEL, max_tokens: 4096,
        system: `You are "${name}" (${role}). Complete tasks. Use plan_approval to get lead approval before major changes. Use send_message to communicate.`,
        tools: TEAMMATE_TOOLS, messages: msgs,
      });
      let text = ""; for (const b of resp.content) if (b.type === "text") text += b.text;
      if (text) console.log(`${c.blue}[${name}]${c.reset} ${text.slice(0, 200)}`);
      msgs.push({ role: "assistant", content: resp.content });
      if (resp.stop_reason !== "tool_use") { if (text) bus.send("lead", { type: "result", from: name, content: text, timestamp: Date.now() }); break; }

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const b of resp.content) {
        if (b.type !== "tool_use") continue;
        const input = b.input as Record<string, unknown>;
        let output: string;
        if (b.name === "send_message") { bus.send((input.to as string) || "lead", { type: "message", from: name, content: input.content as string, timestamp: Date.now() }); output = "Sent"; }
        else if (b.name === "plan_approval") {
          const reqId = randomUUID().slice(0, 8);
          protocolTracker.set(reqId, { id: reqId, type: "plan_approval", from: name, plan: input.plan as string, status: "pending" });
          bus.send("lead", { type: "plan_approval", from: name, content: input.plan as string, timestamp: Date.now(), extra: { request_id: reqId } });
          output = `Plan submitted for approval (request: ${reqId}). Waiting for lead response.`;
        }
        else { output = (H[b.name] ?? (() => "Unknown"))(input); }
        results.push({ type: "tool_result", tool_use_id: b.id, content: output });
      }
      msgs.push({ role: "user", content: results });
    }
    const m = this.config.members.find((m) => m.name === name);
    if (m) { m.status = shouldExit ? "shutdown" : "completed"; this.saveConfig(); }
  }

  list(): string {
    if (this.config.members.length === 0) return "No teammates";
    return this.config.members.map((m) => `${{ active: "◉", completed: "✓", shutdown: "⏹" }[m.status] || "○"} ${m.name} (${m.role}) [${m.status}]`).join("\n");
  }
  private saveConfig() { if (!existsSync(TEAM_DIR)) mkdirSync(TEAM_DIR, { recursive: true }); writeFileSync(join(TEAM_DIR, "config.json"), JSON.stringify(this.config, null, 2)); }
}

const teamMgr = new TeammateManager();

type TH = (i: Record<string, unknown>) => string;
const H: Record<string, TH> = {
  Bash: (i) => { try { return execSync(i.command as string, { encoding: "utf-8", timeout: 30_000, cwd: process.cwd() }).slice(0, 15_000); } catch (e: unknown) { const err = e as { stdout?: string; stderr?: string; message?: string }; return [err.stdout, err.stderr, err.message].filter(Boolean).join("\n").slice(0, 15_000); } },
  Read: (i) => { try { const ls = readFileSync(resolve(i.file_path as string), "utf-8").split("\n"); const s = Math.max(0, ((i.offset as number) ?? 1) - 1); const e = i.limit ? s + (i.limit as number) : ls.length; return ls.slice(s, e).map((l, j) => `${String(s + j + 1).padStart(6)}|${l}`).join("\n") || "(empty)"; } catch (e: unknown) { return `Error: ${(e as Error).message}`; } },
  Write: (i) => { try { const p = resolve(i.file_path as string); if (!existsSync(dirname(p))) mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, i.content as string, "utf-8"); return `Written: ${p}`; } catch (e: unknown) { return `Error: ${(e as Error).message}`; } },
  Edit: (i) => { try { const p = resolve(i.file_path as string); const ct = readFileSync(p, "utf-8"); const old = i.old_string as string; const n = ct.split(old).length - 1; if (n === 0) return "Error: not found"; if (n > 1) return `Error: ${n} matches`; writeFileSync(p, ct.replace(old, i.new_string as string), "utf-8"); return `Edited: ${p}`; } catch (e: unknown) { return `Error: ${(e as Error).message}`; } },
};

const TEAMMATE_TOOLS: Anthropic.Tool[] = [
  { name: "Bash", description: "Run command.", input_schema: { type: "object" as const, properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "Read", description: "Read file.", input_schema: { type: "object" as const, properties: { file_path: { type: "string" } }, required: ["file_path"] } },
  { name: "Write", description: "Write file.", input_schema: { type: "object" as const, properties: { file_path: { type: "string" }, content: { type: "string" } }, required: ["file_path", "content"] } },
  { name: "Edit", description: "Edit file.", input_schema: { type: "object" as const, properties: { file_path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } }, required: ["file_path", "old_string", "new_string"] } },
  { name: "send_message", description: "Send message to agent.", input_schema: { type: "object" as const, properties: { to: { type: "string" }, content: { type: "string" } }, required: ["content"] } },
  { name: "plan_approval", description: "Submit a plan for lead approval before major changes.", input_schema: { type: "object" as const, properties: { plan: { type: "string", description: "Description of the proposed plan" } }, required: ["plan"] } },
];

const LEAD_TOOLS: Anthropic.Tool[] = [
  ...TEAMMATE_TOOLS.filter((t) => !["plan_approval"].includes(t.name)),
  { name: "team_spawn", description: "Spawn teammate.", input_schema: { type: "object" as const, properties: { name: { type: "string" }, role: { type: "string" }, task: { type: "string" } }, required: ["name", "role", "task"] } },
  { name: "team_list", description: "List teammates.", input_schema: { type: "object" as const, properties: {}, required: [] } },
  { name: "shutdown_request", description: "Request a teammate to shutdown gracefully.", input_schema: { type: "object" as const, properties: { target: { type: "string" } }, required: ["target"] } },
  { name: "approve_plan", description: "Approve or reject a teammate's plan.", input_schema: { type: "object" as const, properties: { request_id: { type: "string" }, approve: { type: "boolean" }, feedback: { type: "string" } }, required: ["request_id", "approve"] } },
];

async function agentLoop(messages: Anthropic.MessageParam[]) {
  for (let turn = 0; turn < 50; turn++) {
    const inbox = bus.readInbox("lead");
    if (inbox.length > 0) {
      const text = inbox.map((m) => {
        let line = `[${m.type} from ${m.from}] ${m.content}`;
        if (m.extra?.request_id) line += ` (request_id: ${m.extra.request_id})`;
        return line;
      }).join("\n");
      messages.push({ role: "user", content: `[Team messages]\n${text}` });
    }

    const resp = await client.messages.create({ model: MODEL, max_tokens: 8192, system: "You are the lead. Manage teammates. Use approve_plan to approve/reject plans. Use shutdown_request for graceful shutdown.", tools: LEAD_TOOLS, messages });
    for (const b of resp.content) if (b.type === "text") process.stdout.write(b.text);
    messages.push({ role: "assistant", content: resp.content });
    if (resp.stop_reason !== "tool_use") { console.log(); return; }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const b of resp.content) {
      if (b.type !== "tool_use") continue;
      const input = b.input as Record<string, unknown>;
      let output: string;
      if (b.name === "team_spawn") output = teamMgr.spawn(input.name as string, input.role as string, input.task as string);
      else if (b.name === "team_list") output = teamMgr.list();
      else if (b.name === "send_message") { bus.send(input.to as string, { type: "message", from: "lead", content: input.content as string, timestamp: Date.now() }); output = "Sent"; }
      else if (b.name === "shutdown_request") {
        const reqId = randomUUID().slice(0, 8);
        bus.send(input.target as string, { type: "shutdown_request", from: "lead", content: "Please shutdown", timestamp: Date.now(), extra: { request_id: reqId } });
        output = `Shutdown request sent to ${input.target} (${reqId})`;
      }
      else if (b.name === "approve_plan") {
        const req = protocolTracker.get(input.request_id as string);
        if (!req) { output = `Request ${input.request_id} not found`; }
        else { req.status = input.approve ? "approved" : "rejected"; req.feedback = input.feedback as string; bus.send(req.from, { type: "plan_approval_response", from: "lead", content: input.approve ? "Approved" : `Rejected: ${input.feedback}`, timestamp: Date.now(), extra: { request_id: req.id, approve: input.approve } }); output = `Plan ${req.id} ${req.status}`; }
      }
      else output = (H[b.name] ?? (() => "Unknown"))(input);
      console.log(`\n${c.cyan}[${b.name}]${c.reset} ${JSON.stringify(input).slice(0, 80)}`);
      const preview = output.slice(0, 300); if (preview.trim()) console.log(`${c.dim}${preview}${c.reset}`);
      results.push({ type: "tool_result", tool_use_id: b.id, content: output });
    }
    messages.push({ role: "user", content: results });
  }
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log("minicc s10 — Team Protocols (request-response negotiation)");
  const messages: Anthropic.MessageParam[] = [];
  const ask = () => rl.question(`${c.green}>${c.reset} `, async (input) => {
    if (input.trim().toLowerCase() === "exit") return rl.close();
    if (input.trim().toLowerCase() === "team") { console.log(teamMgr.list()); return ask(); }
    if (!input.trim()) return ask();
    messages.push({ role: "user", content: input });
    try { await agentLoop(messages); } catch (e: unknown) { console.error((e as Error).message); }
    ask();
  });
  ask();
}
main();
