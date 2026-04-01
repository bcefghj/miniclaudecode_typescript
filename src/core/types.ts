/**
 * Core type definitions for miniclaudecode.
 * Mirrors the essential type contracts from Claude Code's Tool.ts
 * without the 793 lines of UI rendering, MCP, and feature flags.
 */

import type Anthropic from "@anthropic-ai/sdk";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Anthropic.Tool["input_schema"];
  isReadOnly?: boolean;
  isConcurrencySafe?: boolean;
}

export interface ToolResult {
  output: string;
  isError?: boolean;
}

export interface Tool extends ToolDefinition {
  execute(input: Record<string, unknown>): Promise<ToolResult>;
}

export interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export type PermissionDecision = "allow" | "deny" | "ask";

export interface PermissionRule {
  tool: string;
  pattern?: string;
  action: "allow" | "deny";
}

export interface AgentConfig {
  model: string;
  maxTokens: number;
  maxTurns: number;
  systemPrompt: string;
  tools: Tool[];
}

export interface StreamEvent {
  type: "text" | "tool_start" | "tool_result" | "complete" | "error" | "compact";
  content?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: string;
}
