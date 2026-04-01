/**
 * Glob tool — find files by pattern.
 * Claude Code's GlobTool delegates to a native binary for speed.
 * This uses a simple recursive walk with pattern matching.
 */

import { readdirSync, statSync } from "fs";
import { join, relative, resolve } from "path";
import type { Tool, ToolResult } from "../core/types.js";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__", ".venv"]);

function matchPattern(filename: string, pattern: string): boolean {
  const cleaned = pattern.replace(/^\*\*\//, "");
  const re = cleaned.replace(/\./g, "\\.").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${re}$`).test(filename);
}

function walkDir(dir: string, pattern: string, results: string[], base: string, depth: number) {
  if (results.length > 500 || depth > 20) return;
  try {
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith(".") && entry !== ".github") continue;
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      try {
        const stat = statSync(full);
        if (stat.isDirectory()) {
          walkDir(full, pattern, results, base, depth + 1);
        } else if (matchPattern(entry, pattern)) {
          results.push(relative(base, full));
        }
      } catch { /* skip inaccessible */ }
    }
  } catch { /* skip */ }
}

export const GlobTool: Tool = {
  name: "Glob",
  description: "Find files matching a glob pattern recursively.",
  inputSchema: {
    type: "object" as const,
    properties: {
      pattern: { type: "string", description: 'Glob pattern, e.g. "**/*.ts", "*.json"' },
      path: { type: "string", description: "Directory to search (default: cwd)" },
    },
    required: ["pattern"],
  },
  isReadOnly: true,
  isConcurrencySafe: true,

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const pattern = input.pattern as string;
    const base = resolve((input.path as string) || process.cwd());
    const results: string[] = [];

    walkDir(base, pattern, results, base, 0);

    return {
      output: results.length > 0
        ? results.sort().join("\n")
        : "No files found matching pattern",
    };
  },
};
