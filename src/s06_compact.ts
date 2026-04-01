#!/usr/bin/env npx tsx
/**
 * s06 — Compact: Three-Layer Context Compression (~400 lines)
 *
 * Context will fill up; three-layer compression enables infinite sessions.
 *   Layer 1: microCompact — replace old tool_results with placeholders
 *   Layer 2: autoCompact — when tokens exceed threshold, summarize + persist to disk
 *   Layer 3: manual compact — user/tool triggers full compression
 *
 * SOURCE MAPPING (Claude Code 原版对照):
 *   services/compact/microCompact.ts (530 lines) → microCompact() here
 *   services/compact/autoCompact.ts (351 lines) → autoCompact() here
 *   services/compact/compact.ts (1705 lines) → compactConversation() here
 *   Distillation ratio: 2586 lines → ~400 lines (6.5:1)
 */

import Anthropic from "@anthropic-ai/sdk";
import { execSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from "fs";
import { dirname, resolve, join } from "path";
import * as readline from "readline";

const client = new Anthropic();
const MODEL = process.env.MINICC_MODEL || "claude-sonnet-4-20250514";
const c = { reset: "\x1b[0m", dim: "\x1b[90m", cyan: "\x1b[36m", green: "\x1b[32m", yellow: "\x1b[33m" };

const COMPACT_THRESHOLD = 80_000;
const KEEP_RECENT_RESULTS = 3;

// ── Layer 1: Micro Compact ────────────────────────────────────────
// Replace old tool_results with short placeholders to save tokens.
// SOURCE: microCompact.ts scans messages, replaces content beyond KEEP_RECENT

function microCompact(messages: Anthropic.MessageParam[]): void {
  let toolResultCount = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "user" || typeof msg.content === "string") continue;
    if (!Array.isArray(msg.content)) continue;

    for (let j = 0; j < msg.content.length; j++) {
      const part = msg.content[j];
      if (part.type !== "tool_result") continue;
      toolResultCount++;

      if (toolResultCount > KEEP_RECENT_RESULTS) {
        const content = typeof part.content === "string" ? part.content : "";
        if (content.length > 100) {
          (msg.content as Anthropic.ToolResultBlockParam[])[j] = {
            ...part,
            content: `[Previous tool result truncated — was ${content.length} chars]`,
          };
        }
      }
    }
  }
}

// ── Layer 2: Auto Compact ─────────────────────────────────────────
// When estimated tokens exceed threshold, summarize old messages and persist.
// SOURCE: autoCompact.ts uses tokenCountWithEstimation, calls compactConversation

function estimateTokens(messages: Anthropic.MessageParam[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

async function autoCompact(
  messages: Anthropic.MessageParam[]
): Promise<Anthropic.MessageParam[]> {
  const tokens = estimateTokens(messages);
  if (tokens < COMPACT_THRESHOLD || messages.length < 8) return messages;

  console.log(`${c.yellow}[Auto-compact: ~${tokens} tokens → summarizing]${c.reset}`);
  return compactConversation(messages);
}

// ── Layer 3: Full Compact ─────────────────────────────────────────
// Persist transcript to disk, generate summary, replace messages.
// SOURCE: compact.ts:compactConversation() writes .transcripts/, calls model for summary

async function compactConversation(
  messages: Anthropic.MessageParam[]
): Promise<Anthropic.MessageParam[]> {
  const keepRecent = messages.slice(-6);
  const toSummarize = messages.slice(0, -6);

  // Persist to disk
  const transcriptDir = join(process.cwd(), ".transcripts");
  if (!existsSync(transcriptDir)) mkdirSync(transcriptDir, { recursive: true });
  const transcriptPath = join(transcriptDir, `transcript_${Date.now()}.jsonl`);
  for (const msg of toSummarize) {
    appendFileSync(transcriptPath, JSON.stringify(msg) + "\n");
  }

  // Generate summary via model
  const summaryResp = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    system: "Summarize this conversation concisely. Preserve: key decisions, file paths modified, code changes made, current task status. Be factual and specific.",
    messages: [
      { role: "user", content: `Summarize the following conversation:\n${JSON.stringify(toSummarize).slice(0, 50_000)}` },
    ],
  });

  const summaryText = summaryResp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  const preTokens = estimateTokens(messages);
  const newMessages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `[Conversation compacted — transcript saved to ${transcriptPath}]\n\n## Summary of previous conversation:\n${summaryText}`,
    },
    {
      role: "assistant",
      content: "Understood. I have the context from the summary. How can I continue helping?",
    },
    ...keepRecent,
  ];
  const postTokens = estimateTokens(newMessages);

  console.log(`${c.yellow}[Compacted: ~${preTokens} → ~${postTokens} tokens, saved ${messages.length - keepRecent.length} messages to disk]${c.reset}`);
  return newMessages;
}

// ── Tool Handlers ─────────────────────────────────────────────────

type TH = (i: Record<string, unknown>) => string;
const H: Record<string, TH> = {
  Bash: (i) => { try { return execSync(i.command as string, { encoding: "utf-8", timeout: 30_000, cwd: process.cwd() }).slice(0, 15_000); } catch (e: unknown) { const err = e as { stdout?: string; stderr?: string; message?: string }; return [err.stdout, err.stderr, err.message].filter(Boolean).join("\n").slice(0, 15_000); } },
  Read: (i) => { try { const ls = readFileSync(resolve(i.file_path as string), "utf-8").split("\n"); const s = Math.max(0, ((i.offset as number) ?? 1) - 1); const e = i.limit ? s + (i.limit as number) : ls.length; return ls.slice(s, e).map((l, j) => `${String(s + j + 1).padStart(6)}|${l}`).join("\n") || "(empty)"; } catch (e: unknown) { return `Error: ${(e as Error).message}`; } },
  Write: (i) => { try { const p = resolve(i.file_path as string); if (!existsSync(dirname(p))) mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, i.content as string, "utf-8"); return `Written: ${p}`; } catch (e: unknown) { return `Error: ${(e as Error).message}`; } },
  Edit: (i) => { try { const p = resolve(i.file_path as string); const ct = readFileSync(p, "utf-8"); const old = i.old_string as string; const n = ct.split(old).length - 1; if (n === 0) return "Error: not found"; if (n > 1) return `Error: ${n} matches`; writeFileSync(p, ct.replace(old, i.new_string as string), "utf-8"); return `Edited: ${p}`; } catch (e: unknown) { return `Error: ${(e as Error).message}`; } },
  Glob: (i) => { try { return execSync(`find "${resolve((i.path as string) || ".")}" -name "${i.pattern}" -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null | head -200`, { encoding: "utf-8", timeout: 10_000 }).trim() || "No files"; } catch { return "No files found"; } },
  Grep: (i) => { try { const ga = i.include ? `--glob "${i.include}"` : ""; return execSync(`rg --no-heading -n "${i.pattern}" ${ga} "${resolve((i.path as string) || ".")}" 2>/dev/null | head -150`, { encoding: "utf-8", timeout: 10_000 }).slice(0, 15_000) || "No matches"; } catch { return "No matches"; } },
  Compact: () => "Compact requested — will run after this turn.",
};

const TOOLS: Anthropic.Tool[] = [
  { name: "Bash", description: "Run a shell command.", input_schema: { type: "object" as const, properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "Read", description: "Read a file.", input_schema: { type: "object" as const, properties: { file_path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } }, required: ["file_path"] } },
  { name: "Write", description: "Write a file.", input_schema: { type: "object" as const, properties: { file_path: { type: "string" }, content: { type: "string" } }, required: ["file_path", "content"] } },
  { name: "Edit", description: "Find-replace in file.", input_schema: { type: "object" as const, properties: { file_path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } }, required: ["file_path", "old_string", "new_string"] } },
  { name: "Glob", description: "Find files by pattern.", input_schema: { type: "object" as const, properties: { pattern: { type: "string" }, path: { type: "string" } }, required: ["pattern"] } },
  { name: "Grep", description: "Search file contents.", input_schema: { type: "object" as const, properties: { pattern: { type: "string" }, path: { type: "string" }, include: { type: "string" } }, required: ["pattern"] } },
  { name: "Compact", description: "Trigger conversation compaction to free context space.", input_schema: { type: "object" as const, properties: {}, required: [] } },
];

// ── Agent Loop with Compact Integration ───────────────────────────

async function agentLoop(messages: Anthropic.MessageParam[]) {
  for (let turn = 0; turn < 50; turn++) {
    // Layer 1: micro-compact old results
    microCompact(messages);
    // Layer 2: auto-compact if over threshold
    messages = await autoCompact(messages);

    const resp = await client.messages.create({
      model: MODEL, max_tokens: 8192,
      system: "You are a coding assistant. Use Compact tool when context feels large.",
      tools: TOOLS, messages,
    });

    for (const b of resp.content) if (b.type === "text") process.stdout.write(b.text);
    messages.push({ role: "assistant", content: resp.content });
    if (resp.stop_reason !== "tool_use") { console.log(); return; }

    let compactRequested = false;
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const b of resp.content) {
      if (b.type !== "tool_use") continue;
      const input = b.input as Record<string, unknown>;
      const label = b.name === "Bash" ? `$ ${input.command}` : String(input.file_path || input.pattern || b.name);
      console.log(`\n${c.cyan}[${b.name}]${c.reset} ${label}`);
      if (b.name === "Compact") compactRequested = true;
      const output = (H[b.name] ?? (() => "Unknown tool"))(input);
      const preview = output.slice(0, 400);
      if (preview.trim()) console.log(`${c.dim}${preview}${output.length > 400 ? "..." : ""}${c.reset}`);
      results.push({ type: "tool_result", tool_use_id: b.id, content: output });
    }
    messages.push({ role: "user", content: results });

    // Layer 3: manual compact
    if (compactRequested) {
      const compacted = await compactConversation(messages);
      messages.length = 0;
      messages.push(...compacted);
    }
  }
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log("minicc s06 — Compact (three-layer context compression)");
  console.log(`${c.dim}Auto-compact at ~${COMPACT_THRESHOLD} tokens | Type 'compact' to trigger manually${c.reset}`);
  let messages: Anthropic.MessageParam[] = [];
  const ask = () => rl.question(`${c.green}>${c.reset} `, async (input) => {
    if (input.trim().toLowerCase() === "exit") return rl.close();
    if (input.trim().toLowerCase() === "compact") {
      messages = await compactConversation(messages);
      return ask();
    }
    if (!input.trim()) return ask();
    messages.push({ role: "user", content: input });
    try { await agentLoop(messages); } catch (e: unknown) { console.error((e as Error).message); }
    ask();
  });
  ask();
}
main();
