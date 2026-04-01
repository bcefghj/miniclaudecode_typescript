/**
 * Anthropic API wrapper.
 *
 * Claude Code's services/api/claude.ts is ~3420 lines handling raw streams,
 * VCR recording, Bedrock/Vertex, advisor models, prompt caching,
 * idle watchdogs, and non-streaming fallback.
 *
 * This distills it to: make a streaming API call, yield events, track usage.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Tool, TokenUsage } from "./types.js";

const client = new Anthropic();

export interface CallModelParams {
  model: string;
  maxTokens: number;
  systemPrompt: string;
  messages: Anthropic.MessageParam[];
  tools: Anthropic.Tool[];
}

export interface ModelResponse {
  content: Anthropic.ContentBlock[];
  stopReason: string | null;
  usage: Anthropic.Usage;
}

export async function callModelStreaming(
  params: CallModelParams,
  onText?: (text: string) => void
): Promise<ModelResponse> {
  const stream = client.messages.stream({
    model: params.model,
    max_tokens: params.maxTokens,
    system: params.systemPrompt,
    tools: params.tools,
    messages: params.messages,
  });

  if (onText) {
    stream.on("text", onText);
  }

  const response = await stream.finalMessage();

  return {
    content: response.content,
    stopReason: response.stop_reason,
    usage: response.usage,
  };
}

export async function callModelDirect(
  params: CallModelParams
): Promise<ModelResponse> {
  const response = await client.messages.create({
    model: params.model,
    max_tokens: params.maxTokens,
    system: params.systemPrompt,
    tools: params.tools,
    messages: params.messages,
  });

  return {
    content: response.content,
    stopReason: response.stop_reason,
    usage: response.usage,
  };
}

export function accumulateUsage(
  total: TokenUsage,
  usage: Anthropic.Usage
): void {
  total.inputTokens += usage.input_tokens;
  total.outputTokens += usage.output_tokens;
}

export function estimateCost(usage: TokenUsage): number {
  return (usage.inputTokens * 3 + usage.outputTokens * 15) / 1_000_000;
}
