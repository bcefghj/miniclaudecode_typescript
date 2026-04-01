/**
 * Simplified permission system.
 *
 * Claude Code's permission system spans ~2000 lines across multiple files
 * with managed policies, sandboxing, multi-source rule merging, and
 * classifier-based auto-approval. This distills it to the essentials:
 *   - Read-only tools are always allowed
 *   - Destructive tools require user confirmation (or session-level allow)
 *   - Rules can be added per-tool
 */

import type { PermissionDecision, PermissionRule } from "./types.js";
import * as readline from "readline";

const READ_ONLY_TOOLS = new Set(["Read", "Glob", "Grep", "TodoWrite"]);

export class PermissionManager {
  private rules: PermissionRule[] = [];
  private sessionAllowed = new Set<string>();
  private rl: readline.Interface | null = null;

  constructor(rl?: readline.Interface) {
    this.rl = rl ?? null;
  }

  setRL(rl: readline.Interface) {
    this.rl = rl;
  }

  addRule(rule: PermissionRule) {
    this.rules.push(rule);
  }

  check(toolName: string, input: Record<string, unknown>): PermissionDecision {
    if (READ_ONLY_TOOLS.has(toolName)) return "allow";

    const inputStr = JSON.stringify(input);
    if (this.sessionAllowed.has(`${toolName}:*`)) return "allow";
    if (this.sessionAllowed.has(`${toolName}:${inputStr}`)) return "allow";

    for (const rule of this.rules) {
      if (rule.tool !== toolName) continue;
      if (!rule.pattern || inputStr.includes(rule.pattern)) return rule.action;
    }

    return "ask";
  }

  async requestPermission(
    toolName: string,
    input: Record<string, unknown>,
    displayStr: string
  ): Promise<boolean> {
    if (!this.rl) return true;

    return new Promise((resolve) => {
      this.rl!.question(
        `\x1b[33mAllow ${toolName}: ${displayStr}? [y/n/a(lways)] \x1b[0m`,
        (answer) => {
          const a = answer.trim().toLowerCase();
          if (a === "a") {
            this.sessionAllowed.add(`${toolName}:*`);
            resolve(true);
          } else {
            if (a === "y") {
              this.sessionAllowed.add(`${toolName}:${JSON.stringify(input)}`);
            }
            resolve(a === "y");
          }
        }
      );
    });
  }
}
