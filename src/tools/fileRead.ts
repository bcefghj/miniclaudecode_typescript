/**
 * File Read tool — reads files with line numbers.
 * Distilled from Claude Code's FileReadTool which also handles
 * notebooks, PDFs, images, token budgets, and deduplication.
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import type { Tool, ToolResult } from "../core/types.js";

export const FileReadTool: Tool = {
  name: "Read",
  description:
    "Read a file from disk. Returns contents with line numbers. Use offset/limit for large files.",
  inputSchema: {
    type: "object" as const,
    properties: {
      file_path: { type: "string", description: "Absolute or relative path to the file" },
      offset: { type: "number", description: "Start line (1-indexed, default 1)" },
      limit: { type: "number", description: "Max lines to read (default: entire file)" },
    },
    required: ["file_path"],
  },
  isReadOnly: true,
  isConcurrencySafe: true,

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const filePath = resolve(input.file_path as string);
    const offset = input.offset as number | undefined;
    const limit = input.limit as number | undefined;

    try {
      const content = readFileSync(filePath, "utf-8");
      const lines = content.split("\n");
      const start = Math.max(0, (offset ?? 1) - 1);
      const end = limit ? Math.min(start + limit, lines.length) : lines.length;

      const numbered = lines
        .slice(start, end)
        .map((line, i) => `${String(start + i + 1).padStart(6)}|${line}`)
        .join("\n");

      return { output: numbered || "(empty file)" };
    } catch (e: unknown) {
      return { output: `Error reading file: ${(e as Error).message}`, isError: true };
    }
  },
};
