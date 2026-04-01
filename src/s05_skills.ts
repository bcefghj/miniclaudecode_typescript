#!/usr/bin/env npx tsx
/**
 * s05 — Skills (~350 lines)
 *
 * Inject domain knowledge via tool_result when needed, not upfront in the system prompt.
 * Skills are SKILL.md files loaded on demand — keeping the system prompt lean.
 *
 * SOURCE MAPPING:
 *   tools/SkillTool/ → loads .cursor/skills/, project skills
 *   services/prompt/ → builds system prompt from rules + skills
 *   Distilled: scan dirs for SKILL.md, load rules from AGENTS.md/CLAUDE.md
 */

import Anthropic from "@anthropic-ai/sdk";
import { execSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from "fs";
import { dirname, resolve, join, relative, basename } from "path";
import * as readline from "readline";

const client = new Anthropic();
const MODEL = process.env.MINICC_MODEL || "claude-sonnet-4-20250514";
const c = { reset: "\x1b[0m", dim: "\x1b[90m", cyan: "\x1b[36m", green: "\x1b[32m", magenta: "\x1b[35m", yellow: "\x1b[33m" };

interface TodoItem { id: string; content: string; status: "pending" | "in_progress" | "completed" | "cancelled"; }
let todos: TodoItem[] = [];

// --- Skill & Rule Loading ---
function loadSkills(): string {
  const dirs = [join(process.cwd(), ".cursor", "skills"), join(process.cwd(), ".minicc", "skills"), join(process.cwd(), "skills")];
  const skills: string[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    try {
      for (const entry of readdirSync(dir, { recursive: true }) as string[]) {
        if (entry.endsWith("SKILL.md") || entry.endsWith("skill.md")) {
          skills.push(`## Skill: ${entry}\n${readFileSync(join(dir, entry), "utf-8").slice(0, 2000)}`);
        }
      }
    } catch {}
  }
  return skills.length > 0 ? `\n\n# Available Skills\n${skills.join("\n\n")}` : "";
}

function loadRules(): string {
  const paths = [join(process.cwd(), "AGENTS.md"), join(process.cwd(), "CLAUDE.md"), join(process.cwd(), ".cursor", "rules"), join(process.cwd(), ".minicc", "rules")];
  const rules: string[] = [];
  for (const p of paths) {
    try {
      if (!existsSync(p)) continue;
      const st = statSync(p);
      if (st.isFile()) rules.push(readFileSync(p, "utf-8").slice(0, 2000));
      else if (st.isDirectory()) { for (const f of readdirSync(p)) if (f.endsWith(".md") || f.endsWith(".mdc")) rules.push(readFileSync(join(p, f), "utf-8").slice(0, 1000)); }
    } catch {}
  }
  return rules.length > 0 ? `\n\n# Project Rules\n${rules.join("\n\n")}` : "";
}

function buildSystemPrompt(): string {
  return `You are minicc, a coding assistant. Working directory: ${process.cwd()}
Project: ${basename(process.cwd())}

Tools: Bash, Read, Write, Edit, Glob, Grep, TodoWrite, Task
Rules: Read before editing. Use Edit for changes, Write for new files. Use TodoWrite for planning. Use Task for delegation.
${loadRules()}${loadSkills()}`;
}

// --- Tool Handlers ---
type TH = (i: Record<string, unknown>) => string;
const H: Record<string, TH> = {
  Bash: (i) => { try { return execSync(i.command as string, { encoding: "utf-8", timeout: 30_000, cwd: process.cwd() }).slice(0, 15_000); } catch (e: unknown) { const err = e as { stdout?: string; stderr?: string; message?: string }; return [err.stdout, err.stderr, err.message].filter(Boolean).join("\n").slice(0, 15_000); } },
  Read: (i) => { try { const ls = readFileSync(resolve(i.file_path as string), "utf-8").split("\n"); const s = Math.max(0, ((i.offset as number) ?? 1) - 1); const e = i.limit ? s + (i.limit as number) : ls.length; return ls.slice(s, e).map((l, j) => `${String(s + j + 1).padStart(6)}|${l}`).join("\n") || "(empty)"; } catch (e: unknown) { return `Error: ${(e as Error).message}`; } },
  Write: (i) => { try { const p = resolve(i.file_path as string); if (!existsSync(dirname(p))) mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, i.content as string, "utf-8"); return `Written: ${p}`; } catch (e: unknown) { return `Error: ${(e as Error).message}`; } },
  Edit: (i) => { try { const p = resolve(i.file_path as string); const ct = readFileSync(p, "utf-8"); const old = i.old_string as string; const n = ct.split(old).length - 1; if (n === 0) return "Error: not found"; if (n > 1) return `Error: ${n} matches`; writeFileSync(p, ct.replace(old, i.new_string as string), "utf-8"); return `Edited: ${p}`; } catch (e: unknown) { return `Error: ${(e as Error).message}`; } },
  Glob: (i) => { const base = resolve((i.path as string) || process.cwd()); const results: string[] = []; const pat = (i.pattern as string).replace(/^\*\*\//, ""); const re = new RegExp("^" + pat.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$"); function walk(d: string, depth: number) { if (results.length > 300 || depth > 15) return; try { for (const e of readdirSync(d)) { if (e.startsWith(".") || e === "node_modules") continue; const f = join(d, e); try { const s = statSync(f); if (s.isDirectory()) walk(f, depth + 1); else if (re.test(e)) results.push(relative(base, f)); } catch {} } } catch {} } walk(base, 0); return results.length > 0 ? results.sort().join("\n") : "No files found"; },
  Grep: (i) => { try { const ga = i.include ? `--glob "${i.include}"` : ""; return execSync(`rg --no-heading -n "${i.pattern}" ${ga} "${resolve((i.path as string) || ".")}" 2>/dev/null | head -150`, { encoding: "utf-8", timeout: 10_000 }).slice(0, 15_000) || "No matches"; } catch { return "No matches"; } },
  TodoWrite: (i) => { for (const item of i.todos as TodoItem[]) { const ex = todos.find((t) => t.id === item.id); if (ex) { ex.content = item.content; ex.status = item.status; } else todos.push(item); } return todos.map((t) => `${{ pending: "○", in_progress: "◉", completed: "✓", cancelled: "✗" }[t.status]} ${t.id}: ${t.content}`).join("\n"); },
};

const TOOLS: Anthropic.Tool[] = [
  { name: "Bash", description: "Run a shell command.", input_schema: { type: "object" as const, properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "Read", description: "Read a file.", input_schema: { type: "object" as const, properties: { file_path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } }, required: ["file_path"] } },
  { name: "Write", description: "Write a file.", input_schema: { type: "object" as const, properties: { file_path: { type: "string" }, content: { type: "string" } }, required: ["file_path", "content"] } },
  { name: "Edit", description: "Find-replace in file.", input_schema: { type: "object" as const, properties: { file_path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } }, required: ["file_path", "old_string", "new_string"] } },
  { name: "Glob", description: "Find files by pattern.", input_schema: { type: "object" as const, properties: { pattern: { type: "string" }, path: { type: "string" } }, required: ["pattern"] } },
  { name: "Grep", description: "Search file contents.", input_schema: { type: "object" as const, properties: { pattern: { type: "string" }, path: { type: "string" }, include: { type: "string" } }, required: ["pattern"] } },
  { name: "TodoWrite", description: "Plan tasks.", input_schema: { type: "object" as const, properties: { todos: { type: "array", items: { type: "object", properties: { id: { type: "string" }, content: { type: "string" }, status: { type: "string", enum: ["pending", "in_progress", "completed", "cancelled"] } }, required: ["id", "content", "status"] } } }, required: ["todos"] } },
  { name: "Task", description: "Delegate to isolated sub-agent.", input_schema: { type: "object" as const, properties: { description: { type: "string" }, prompt: { type: "string" } }, required: ["description", "prompt"] } },
];

async function runSubAgent(desc: string, prompt: string, depth: number): Promise<string> {
  if (depth > 3) return "Error: max depth"; console.log(`\n${c.magenta}  ⤷ Sub-agent: ${desc}${c.reset}`);
  const subTools = TOOLS.filter((t) => t.name !== "Task" || depth < 2);
  const msgs: Anthropic.MessageParam[] = [{ role: "user", content: prompt }]; let result = "";
  for (let turn = 0; turn < 15; turn++) {
    const resp = await client.messages.create({ model: MODEL, max_tokens: 8192, system: "Focused sub-agent. Complete task, return summary.", tools: subTools, messages: msgs });
    let text = ""; for (const b of resp.content) if (b.type === "text") { process.stdout.write(`${c.dim}${b.text}${c.reset}`); text += b.text; }
    msgs.push({ role: "assistant", content: resp.content }); result = text;
    if (resp.stop_reason !== "tool_use") break;
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const b of resp.content) { if (b.type !== "tool_use") continue; const input = b.input as Record<string, unknown>; const output = b.name === "Task" ? await runSubAgent(input.description as string, input.prompt as string, depth + 1) : (H[b.name] ?? (() => "Unknown"))(input); results.push({ type: "tool_result", tool_use_id: b.id, content: output }); }
    msgs.push({ role: "user", content: results });
  }
  console.log(`${c.magenta}  ⤶ done${c.reset}`); return result || "Sub-agent completed";
}

async function agentLoop(messages: Anthropic.MessageParam[]) {
  const sys = buildSystemPrompt();
  for (let turn = 0; turn < 50; turn++) {
    const resp = await client.messages.create({ model: MODEL, max_tokens: 8192, system: sys, tools: TOOLS, messages });
    for (const b of resp.content) if (b.type === "text") process.stdout.write(b.text);
    messages.push({ role: "assistant", content: resp.content });
    if (resp.stop_reason !== "tool_use") { console.log(); return; }
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const b of resp.content) {
      if (b.type !== "tool_use") continue; const input = b.input as Record<string, unknown>;
      const label = b.name === "Task" ? String(input.description) : b.name === "Bash" ? `$ ${input.command}` : String(input.file_path || input.pattern || "");
      console.log(`\n${c.cyan}[${b.name}]${c.reset} ${label}`);
      let output: string;
      if (b.name === "Task") output = await runSubAgent(input.description as string, input.prompt as string, 1);
      else { output = (H[b.name] ?? (() => "Unknown"))(input); const p = output.slice(0, 400); if (p.trim()) console.log(`${c.dim}${p}${output.length > 400 ? "..." : ""}${c.reset}`); }
      results.push({ type: "tool_result", tool_use_id: b.id, content: output });
    }
    messages.push({ role: "user", content: results });
  }
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log(`minicc s05 — Skills (inject knowledge on demand)\n${c.dim}Skills: ${loadSkills() ? "found" : "none"} | Rules: ${loadRules() ? "found" : "none"}${c.reset}`);
  const messages: Anthropic.MessageParam[] = [];
  const ask = () => rl.question(`${c.green}>${c.reset} `, async (input) => {
    if (input.trim().toLowerCase() === "exit") return rl.close();
    if (!input.trim()) return ask();
    messages.push({ role: "user", content: input });
    try { await agentLoop(messages); } catch (e: unknown) { console.error((e as Error).message); }
    ask();
  });
  ask();
}
main();
