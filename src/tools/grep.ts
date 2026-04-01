/**
 * Grep tool — search file contents with regex.
 * Delegates to ripgrep (rg) if available, falls back to grep.
 */

import { execSync } from "child_process";
import { resolve } from "path";
import type { Tool, ToolResult } from "../core/types.js";

export const GrepTool: Tool = {
  name: "Grep",
  description:
    "Search file contents using a regex pattern. Uses ripgrep for speed.",
  inputSchema: {
    type: "object" as const,
    properties: {
      pattern: { type: "string", description: "Regex pattern to search for" },
      path: { type: "string", description: "File or directory to search (default: cwd)" },
      include: { type: "string", description: 'File glob filter, e.g. "*.ts"' },
    },
    required: ["pattern"],
  },
  isReadOnly: true,
  isConcurrencySafe: true,

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const pattern = input.pattern as string;
    const searchPath = resolve((input.path as string) || process.cwd());
    const include = input.include as string | undefined;

    try {
      const globArg = include ? `--glob "${include}"` : "";
      const cmd = `rg --no-heading -n --max-count 200 "${pattern}" ${globArg} "${searchPath}" 2>/dev/null | head -200`;
      const output = execSync(cmd, {
        encoding: "utf-8",
        timeout: 15000,
        cwd: process.cwd(),
      });
      return { output: output.slice(0, 20000) || "No matches found" };
    } catch {
      // Fallback to grep
      try {
        const includeArg = include ? `--include="${include}"` : "";
        const cmd = `grep -rn "${pattern}" ${includeArg} "${searchPath}" 2>/dev/null | head -200`;
        const output = execSync(cmd, { encoding: "utf-8", timeout: 15000 });
        return { output: output.slice(0, 20000) || "No matches found" };
      } catch {
        return { output: "No matches found" };
      }
    }
  },
};
