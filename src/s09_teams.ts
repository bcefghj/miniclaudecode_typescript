#!/usr/bin/env npx tsx
/**
 * s09 — Agent Teams (~450 lines)
 *
 * When one agent can't finish, delegate to persistent teammates via async mailboxes.
 * Each teammate runs its own agent loop with isolated messages[].
 * Communication happens through JSONL inbox files.
 *
 * SOURCE MAPPING:
 *   utils/swarm/inProcessRunner.ts (1552 lines) → TeammateManager
 *   tools/TeamCreateTool/ (240 lines) → team_spawn tool
 *   Distillation ratio: ~1800 lines → ~450 lines (4:1)
 */

import Anthropic from "@anthropic-ai/sdk";
import { execSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from "fs";
import { dirname, resolve, join } from "path";
import * as readline from "readline";

const client = new Anthropic();
const MODEL = process.env.MINICC_MODEL || "claude-sonnet-4-20250514";
const c = { reset: "\x1b[0m", dim: "\x1b[90m", cyan: "\x1b[36m", green: "\x1b[32m", magenta: "\x1b[35m", blue: "\x1b[34m" };

const TEAM_DIR = join(process.cwd(), ".team");
const INBOX_DIR = join(TEAM_DIR, "inbox");

// ── Message Bus (JSONL inbox files) ───────────────────────────────

interface TeamMessage { type: string; from: string; content: string; timestamp: number; }

class MessageBus {
  constructor() {
    if (!existsSync(INBOX_DIR)) mkdirSync(INBOX_DIR, { recursive: true });
  }

  send(to: string, msg: TeamMessage) {
    const path = join(INBOX_DIR, `${to}.jsonl`);
    appendFileSync(path, JSON.stringify(msg) + "\n");
  }

  readInbox(name: string): TeamMessage[] {
    const path = join(INBOX_DIR, `${name}.jsonl`);
    if (!existsSync(path)) return [];
    const lines = readFileSync(path, "utf-8").trim().split("\n").filter(Boolean);
    writeFileSync(path, ""); // Clear after reading
    return lines.map((l) => JSON.parse(l));
  }
}

const bus = new MessageBus();

// ── Teammate Manager ──────────────────────────────────────────────

interface TeamConfig { members: { name: string; role: string; status: string }[]; }

class TeammateManager {
  private config: TeamConfig = { members: [] };
  private running = new Map<string, Promise<void>>();

  constructor() {
    const configPath = join(TEAM_DIR, "config.json");
    if (existsSync(configPath)) {
      this.config = JSON.parse(readFileSync(configPath, "utf-8"));
    }
  }

  spawn(name: string, role: string, initialTask: string): string {
    if (this.config.members.find((m) => m.name === name)) return `Teammate ${name} already exists`;
    this.config.members.push({ name, role, status: "active" });
    this.saveConfig();

    // Send initial task via inbox
    bus.send(name, { type: "task", from: "lead", content: initialTask, timestamp: Date.now() });

    // Run teammate loop in background
    const promise = this.runTeammateLoop(name, role);
    this.running.set(name, promise);

    return `Spawned teammate "${name}" (${role}) with initial task`;
  }

  private async runTeammateLoop(name: string, role: string) {
    const msgs: Anthropic.MessageParam[] = [];

    for (let turn = 0; turn < 30; turn++) {
      // Read inbox
      const inbox = bus.readInbox(name);
      if (inbox.length > 0) {
        const inboxText = inbox.map((m) => `[From ${m.from}] ${m.content}`).join("\n");
        msgs.push({ role: "user", content: inboxText });
      } else if (msgs.length === 0) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      } else {
        break;
      }

      const resp = await client.messages.create({
        model: MODEL, max_tokens: 4096,
        system: `You are "${name}", a teammate with role: ${role}. Complete assigned tasks. Use send_message to communicate with the lead. Be concise.`,
        tools: TEAMMATE_TOOLS, messages: msgs,
      });

      let text = "";
      for (const b of resp.content) if (b.type === "text") { text += b.text; }
      if (text) console.log(`${c.blue}[${name}]${c.reset} ${text.slice(0, 200)}`);
      msgs.push({ role: "assistant", content: resp.content });

      if (resp.stop_reason !== "tool_use") {
        if (text) bus.send("lead", { type: "result", from: name, content: text, timestamp: Date.now() });
        break;
      }

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const b of resp.content) {
        if (b.type !== "tool_use") continue;
        const input = b.input as Record<string, unknown>;
        let output: string;
        if (b.name === "send_message") {
          const to = (input.to as string) || "lead";
          bus.send(to, { type: "message", from: name, content: input.content as string, timestamp: Date.now() });
          output = `Message sent to ${to}`;
        } else {
          output = (H[b.name] ?? (() => "Unknown"))(input);
        }
        results.push({ type: "tool_result", tool_use_id: b.id, content: output });
      }
      msgs.push({ role: "user", content: results });
    }

    // Mark inactive
    const member = this.config.members.find((m) => m.name === name);
    if (member) { member.status = "completed"; this.saveConfig(); }
  }

  list(): string {
    if (this.config.members.length === 0) return "No teammates";
    return this.config.members.map((m) => `${m.status === "active" ? "◉" : "✓"} ${m.name} (${m.role}) [${m.status}]`).join("\n");
  }

  private saveConfig() {
    if (!existsSync(TEAM_DIR)) mkdirSync(TEAM_DIR, { recursive: true });
    writeFileSync(join(TEAM_DIR, "config.json"), JSON.stringify(this.config, null, 2));
  }
}

const teamMgr = new TeammateManager();

// ── Shared Tool Handlers ──────────────────────────────────────────

type TH = (i: Record<string, unknown>) => string;
const H: Record<string, TH> = {
  Bash: (i) => { try { return execSync(i.command as string, { encoding: "utf-8", timeout: 30_000, cwd: process.cwd() }).slice(0, 15_000); } catch (e: unknown) { const err = e as { stdout?: string; stderr?: string; message?: string }; return [err.stdout, err.stderr, err.message].filter(Boolean).join("\n").slice(0, 15_000); } },
  Read: (i) => { try { const ls = readFileSync(resolve(i.file_path as string), "utf-8").split("\n"); const s = Math.max(0, ((i.offset as number) ?? 1) - 1); const e = i.limit ? s + (i.limit as number) : ls.length; return ls.slice(s, e).map((l, j) => `${String(s + j + 1).padStart(6)}|${l}`).join("\n") || "(empty)"; } catch (e: unknown) { return `Error: ${(e as Error).message}`; } },
  Write: (i) => { try { const p = resolve(i.file_path as string); if (!existsSync(dirname(p))) mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, i.content as string, "utf-8"); return `Written: ${p}`; } catch (e: unknown) { return `Error: ${(e as Error).message}`; } },
  Edit: (i) => { try { const p = resolve(i.file_path as string); const ct = readFileSync(p, "utf-8"); const old = i.old_string as string; const n = ct.split(old).length - 1; if (n === 0) return "Error: not found"; if (n > 1) return `Error: ${n} matches`; writeFileSync(p, ct.replace(old, i.new_string as string), "utf-8"); return `Edited: ${p}`; } catch (e: unknown) { return `Error: ${(e as Error).message}`; } },
};

// Teammate-available tools (subset)
const TEAMMATE_TOOLS: Anthropic.Tool[] = [
  { name: "Bash", description: "Run command.", input_schema: { type: "object" as const, properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "Read", description: "Read file.", input_schema: { type: "object" as const, properties: { file_path: { type: "string" } }, required: ["file_path"] } },
  { name: "Write", description: "Write file.", input_schema: { type: "object" as const, properties: { file_path: { type: "string" }, content: { type: "string" } }, required: ["file_path", "content"] } },
  { name: "Edit", description: "Edit file.", input_schema: { type: "object" as const, properties: { file_path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } }, required: ["file_path", "old_string", "new_string"] } },
  { name: "send_message", description: "Send message to another agent.", input_schema: { type: "object" as const, properties: { to: { type: "string", description: "Recipient name (default: lead)" }, content: { type: "string" } }, required: ["content"] } },
];

// Lead tools
const LEAD_TOOLS: Anthropic.Tool[] = [
  ...TEAMMATE_TOOLS.filter((t) => t.name !== "send_message"),
  { name: "team_spawn", description: "Spawn a new teammate agent with a role and initial task.", input_schema: { type: "object" as const, properties: { name: { type: "string" }, role: { type: "string" }, task: { type: "string" } }, required: ["name", "role", "task"] } },
  { name: "team_list", description: "List all teammates.", input_schema: { type: "object" as const, properties: {}, required: [] } },
  { name: "send_message", description: "Send message to a teammate.", input_schema: { type: "object" as const, properties: { to: { type: "string" }, content: { type: "string" } }, required: ["to", "content"] } },
];

async function agentLoop(messages: Anthropic.MessageParam[]) {
  for (let turn = 0; turn < 50; turn++) {
    // Drain lead's inbox
    const inbox = bus.readInbox("lead");
    if (inbox.length > 0) {
      const inboxText = inbox.map((m) => `[From ${m.from}] (${m.type}) ${m.content}`).join("\n");
      messages.push({ role: "user", content: `[Team messages received]\n${inboxText}` });
    }

    const resp = await client.messages.create({
      model: MODEL, max_tokens: 8192,
      system: "You are the lead agent. Use team_spawn to delegate tasks to teammates. They work independently and send results via messages.",
      tools: LEAD_TOOLS, messages,
    });
    for (const b of resp.content) if (b.type === "text") process.stdout.write(b.text);
    messages.push({ role: "assistant", content: resp.content });
    if (resp.stop_reason !== "tool_use") { console.log(); return; }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const b of resp.content) {
      if (b.type !== "tool_use") continue;
      const input = b.input as Record<string, unknown>;
      let output: string;
      if (b.name === "team_spawn") {
        output = teamMgr.spawn(input.name as string, input.role as string, input.task as string);
      } else if (b.name === "team_list") {
        output = teamMgr.list();
      } else if (b.name === "send_message") {
        bus.send(input.to as string, { type: "message", from: "lead", content: input.content as string, timestamp: Date.now() });
        output = `Message sent to ${input.to}`;
      } else {
        output = (H[b.name] ?? (() => "Unknown"))(input);
      }
      const label = b.name.startsWith("team_") ? `${b.name} ${input.name || ""}` : b.name === "Bash" ? `$ ${input.command}` : String(input.file_path || b.name);
      console.log(`\n${c.cyan}[${b.name}]${c.reset} ${label}`);
      const preview = output.slice(0, 400);
      if (preview.trim()) console.log(`${c.dim}${preview}${output.length > 400 ? "..." : ""}${c.reset}`);
      results.push({ type: "tool_result", tool_use_id: b.id, content: output });
    }
    messages.push({ role: "user", content: results });
  }
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log("minicc s09 — Agent Teams (persistent teammates with async mailboxes)");
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
