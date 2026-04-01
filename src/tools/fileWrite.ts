/**
 * File Write tool — creates or overwrites files.
 * Distilled from Claude Code's FileWriteTool which also tracks
 * file history, staleness checks, git diffs, and LSP notifications.
 */

import { writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname, resolve } from "path";
import type { Tool, ToolResult } from "../core/types.js";

export const FileWriteTool: Tool = {
  name: "Write",
  description:
    "Write content to a file. Creates parent directories if needed. Overwrites existing content.",
  inputSchema: {
    type: "object" as const,
    properties: {
      file_path: { type: "string", description: "Absolute or relative path" },
      content: { type: "string", description: "Complete file content to write" },
    },
    required: ["file_path", "content"],
  },
  isReadOnly: false,
  isConcurrencySafe: false,

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const filePath = resolve(input.file_path as string);
    const content = input.content as string;

    try {
      const dir = dirname(filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      const isNew = !existsSync(filePath);
      writeFileSync(filePath, content, "utf-8");

      return {
        output: isNew
          ? `File created successfully at: ${filePath}`
          : `The file ${filePath} has been updated successfully.`,
      };
    } catch (e: unknown) {
      return { output: `Error writing file: ${(e as Error).message}`, isError: true };
    }
  },
};
