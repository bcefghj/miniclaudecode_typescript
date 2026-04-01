/**
 * The agent loop — the beating heart of every AI coding agent.
 *
 * Claude Code's query.ts is ~1730 lines with streaming tool executors,
 * reactive compaction, model fallback, abort handling, and complex
 * state management. This distills the core pattern:
 *
 *   while (true) {
 *     response = callModel(messages, tools)
 *     if no tool_use → return text
 *     for each tool_use → check permission → execute → append result
 *     continue loop
 *   }
 */

import Anthropic from "@anthropic-ai/sdk";
import { callModelStreaming, accumulateUsage, estimateCost } from "./api.js";
import { PermissionManager } from "./permissions.js";
import type { Tool, TokenUsage, AgentConfig } from "./types.js";

const c = {
  reset: "\x1b[0m", dim: "\x1b[90m", cyan: "\x1b[36m",
  red: "\x1b[31m", yellow: "\x1b[33m", magenta: "\x1b[35m",
};

export interface AgentLoopOptions {
  config: AgentConfig;
  permissions: PermissionManager;
  usage: TokenUsage;
  onText?: (text: string) => void;
  maxTurns?: number;
}

function formatToolInput(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "Bash": return `$ ${input.command}`;
    case "Read": return String(input.file_path ?? "");
    case "Write": return String(input.file_path ?? "");
    case "Edit": return String(input.file_path ?? "");
    case "Glob": return String(input.pattern ?? "");
    case "Grep": return `/${input.pattern}/`;
    case "Task": return String(input.description ?? "");
    case "TodoWrite": return `${Array.isArray(input.todos) ? input.todos.length : "?"} items`;
    default: return JSON.stringify(input).slice(0, 80);
  }
}

export async function runAgentLoop(
  messages: Anthropic.MessageParam[],
  options: AgentLoopOptions
): Promise<string> {
  const { config, permissions, usage, onText } = options;
  const maxTurns = options.maxTurns ?? config.maxTurns;
  const toolMap = new Map(config.tools.map((t) => [t.name, t]));
  const apiTools: Anthropic.Tool[] = config.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));

  for (let turn = 0; turn < maxTurns; turn++) {
    const response = await callModelStreaming(
      {
        model: config.model,
        maxTokens: config.maxTokens,
        systemPrompt: config.systemPrompt,
        messages,
        tools: apiTools,
      },
      onText ?? ((text) => process.stdout.write(text))
    );

    accumulateUsage(usage, response.usage);

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );

    messages.push({ role: "assistant", content: response.content });

    if (response.stopReason !== "tool_use" || toolUses.length === 0) {
      const cost = estimateCost(usage);
      console.log(
        `\n${c.dim}[${usage.inputTokens}in/${usage.outputTokens}out ~$${cost.toFixed(4)}]${c.reset}`
      );
      return response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n");
    }

    // Execute tools
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const toolUse of toolUses) {
      const input = toolUse.input as Record<string, unknown>;
      const tool = toolMap.get(toolUse.name);
      const displayStr = formatToolInput(toolUse.name, input);

      if (!tool) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: `Unknown tool: ${toolUse.name}`,
          is_error: true,
        });
        continue;
      }

      // Permission check
      const perm = permissions.check(toolUse.name, input);
      if (perm === "deny") {
        console.log(`\n${c.red}[${toolUse.name} DENIED]${c.reset} ${displayStr}`);
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: `Permission denied for ${toolUse.name}`,
          is_error: true,
        });
        continue;
      }

      if (perm === "ask") {
        const allowed = await permissions.requestPermission(toolUse.name, input, displayStr);
        if (!allowed) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: `User rejected ${toolUse.name}`,
            is_error: true,
          });
          continue;
        }
      }

      console.log(`\n${c.cyan}[${toolUse.name}]${c.reset} ${displayStr}`);

      try {
        const result = await tool.execute(input);
        const preview = result.output.slice(0, 500);
        if (preview.trim()) {
          console.log(`${c.dim}${preview}${result.output.length > 500 ? "..." : ""}${c.reset}`);
        }
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: result.output,
          is_error: result.isError,
        });
      } catch (e: unknown) {
        const errMsg = `Tool error: ${(e as Error).message}`;
        console.log(`${c.red}${errMsg}${c.reset}`);
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: errMsg,
          is_error: true,
        });
      }
    }

    messages.push({ role: "user", content: toolResults });
  }

  return "Max turns reached";
}
