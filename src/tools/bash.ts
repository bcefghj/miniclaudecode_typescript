/**
 * Bash tool — runs shell commands.
 * Distilled from Claude Code's BashTool (~800 lines) which includes
 * sandbox integration, background tasks, sed simulation, and PowerShell support.
 */

import { execSync } from "child_process";
import type { Tool, ToolResult } from "../core/types.js";

export const BashTool: Tool = {
  name: "Bash",
  description: "Run a shell command and return stdout/stderr.",
  inputSchema: {
    type: "object" as const,
    properties: {
      command: { type: "string", description: "The bash command to execute" },
      timeout: { type: "number", description: "Timeout in milliseconds (default 30000)" },
    },
    required: ["command"],
  },
  isReadOnly: false,
  isConcurrencySafe: false,

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const command = input.command as string;
    const timeout = (input.timeout as number) ?? 30000;

    try {
      const output = execSync(command, {
        encoding: "utf-8",
        timeout,
        cwd: process.cwd(),
        env: { ...process.env, FORCE_COLOR: "0" },
        maxBuffer: 1024 * 1024,
      });
      return { output: output.slice(0, 20000) || "(no output)" };
    } catch (e: unknown) {
      const err = e as { stdout?: string; stderr?: string; message?: string; status?: number };
      const parts = [err.stdout, err.stderr].filter(Boolean).join("\n");
      return {
        output: (parts || err.message || "Command failed").slice(0, 20000),
        isError: true,
      };
    }
  },
};
