/**
 * Tool registry — exports all available tools.
 *
 * Claude Code's tools.ts registers 30+ tools with conditional loading
 * based on feature flags, user type, and environment. This exports
 * the essential 6 tools that cover 95% of coding tasks.
 */

export { BashTool } from "./bash.js";
export { FileReadTool } from "./fileRead.js";
export { FileWriteTool } from "./fileWrite.js";
export { FileEditTool } from "./fileEdit.js";
export { GlobTool } from "./glob.js";
export { GrepTool } from "./grep.js";

import { BashTool } from "./bash.js";
import { FileReadTool } from "./fileRead.js";
import { FileWriteTool } from "./fileWrite.js";
import { FileEditTool } from "./fileEdit.js";
import { GlobTool } from "./glob.js";
import { GrepTool } from "./grep.js";
import type { Tool } from "../core/types.js";

export function getAllTools(): Tool[] {
  return [BashTool, FileReadTool, FileWriteTool, FileEditTool, GlobTool, GrepTool];
}
