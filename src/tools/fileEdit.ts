/**
 * File Edit tool — find-and-replace in files.
 * Distilled from Claude Code's FileEditTool which also handles
 * fuzzy matching, staleness detection, encoding preservation,
 * structured patches, and notebook redirection.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname, resolve } from "path";
import type { Tool, ToolResult } from "../core/types.js";

export const FileEditTool: Tool = {
  name: "Edit",
  description:
    "Find and replace a unique string in a file. The old_string must match exactly (including whitespace and indentation).",
  inputSchema: {
    type: "object" as const,
    properties: {
      file_path: { type: "string", description: "Path to the file to edit" },
      old_string: { type: "string", description: "Exact text to find and replace" },
      new_string: { type: "string", description: "Replacement text" },
      replace_all: {
        type: "boolean",
        description: "Replace all occurrences (default: false, requires unique match)",
      },
    },
    required: ["file_path", "old_string", "new_string"],
  },
  isReadOnly: false,
  isConcurrencySafe: false,

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const filePath = resolve(input.file_path as string);
    const oldStr = input.old_string as string;
    const newStr = input.new_string as string;
    const replaceAll = (input.replace_all as boolean) ?? false;

    if (oldStr === newStr) {
      return { output: "Error: old_string and new_string are identical", isError: true };
    }

    // Create mode: empty old_string means create new file
    if (oldStr === "" && newStr !== "") {
      if (existsSync(filePath)) {
        return { output: "Error: File exists. Use non-empty old_string to edit.", isError: true };
      }
      try {
        const dir = dirname(filePath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(filePath, newStr, "utf-8");
        return { output: `Created: ${filePath}` };
      } catch (e: unknown) {
        return { output: `Error: ${(e as Error).message}`, isError: true };
      }
    }

    try {
      let content = readFileSync(filePath, "utf-8");
      const count = content.split(oldStr).length - 1;

      if (count === 0) {
        return { output: `Error: old_string not found in ${filePath}`, isError: true };
      }
      if (count > 1 && !replaceAll) {
        return {
          output: `Error: old_string found ${count} times — must be unique. Include more context or use replace_all.`,
          isError: true,
        };
      }

      if (replaceAll) {
        content = content.split(oldStr).join(newStr);
      } else {
        content = content.replace(oldStr, newStr);
      }

      writeFileSync(filePath, content, "utf-8");
      return {
        output: `Edited: ${filePath}${replaceAll ? ` (${count} replacements)` : ""}`,
      };
    } catch (e: unknown) {
      return { output: `Error: ${(e as Error).message}`, isError: true };
    }
  },
};
