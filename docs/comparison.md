# Claude Code vs miniclaudecode 对比

## 功能对比

| 功能 | Claude Code | miniclaudecode | 说明 |
|------|:-----------:|:--------------:|------|
| Agent 循环 | ✅ | ✅ | 核心相同 |
| 流式输出 | ✅ | ✅ (v2+) | SDK stream |
| Bash 工具 | ✅ | ✅ | 简化版 |
| 文件读取 | ✅ | ✅ | 无 PDF/图片 |
| 文件写入 | ✅ | ✅ | 无 staleness |
| 文件编辑 | ✅ | ✅ | 无模糊匹配 |
| Glob 搜索 | ✅ | ✅ | 纯 JS 实现 |
| Grep 搜索 | ✅ | ✅ | 使用 rg |
| 子 Agent | ✅ | ✅ (v3+) | 简化版 |
| Todo 规划 | ✅ | ✅ (v3+) | 相同 |
| 权限系统 | ✅ | ✅ (v4) | 三档简化版 |
| 技能系统 | ✅ | ✅ (v4) | SKILL.md |
| 上下文压缩 | ✅ | ✅ (v4) | 简化版 |
| Token 追踪 | ✅ | ✅ (v2+) | 基础版 |
| MCP | ✅ | ❌ | 扩展协议 |
| TUI (React/Ink) | ✅ | ❌ | 用 readline |
| 远程会话 | ✅ | ❌ | 非核心 |
| Sandbox | ✅ | ❌ | 安全层 |
| 多模型切换 | ✅ | ❌ | 可用环境变量 |
| Coordinator | ✅ | ❌ | 多 Agent 编排 |
| Voice/语音 | ✅ | ❌ | 特殊功能 |
| KAIROS/BUDDY | ✅ | ❌ | 隐藏功能 |

## 代码规模对比

```
Claude Code (原版)          miniclaudecode (蒸馏版)
────────────────────       ─────────────────────
512,664 行 TypeScript       2,635 行 TypeScript
1,884 个文件                 17 个文件
30+ 工具                     6 个工具 + TodoWrite + Task
200+ React 组件              0 (readline)
~100+ npm 依赖               2 个依赖
```

## 与其他蒸馏项目对比

| 项目 | 语言 | 行数 | 特点 |
|------|------|------|------|
| **miniclaudecode_typescript** | TypeScript | ~2,635 | 渐进式5版本，教学为主 |
| shareAI-lab/mini-claude-code | Python | ~550 | 渐进式教程，Python版 |
| e10nMa2k/cc-mini | - | ~800 | 最小复现 |
| davidweidawang/ClaudeLite | Python | 轻量 | 核心架构复现 |
| yinwm/minicc | - | ~800 | 教育性实现 |
| miniclawd | TypeScript | ~5,900 | 多LLM、技能、npm包 |

## 架构模式保留程度

### Agent 循环 — 100% 保留

```
原版: query.ts → queryLoop → while(true) → callModel → runTools → continue
蒸馏: agentLoop.ts → runAgentLoop → while(true) → callModelStreaming → executeTool → continue
```

模式完全一致，去掉了错误恢复、reactive compact、model fallback 等边缘路径。

### 工具系统 — 核心保留

```
原版: buildTool(def) → { name, call, inputSchema, checkPermissions, ... } (40+ 字段)
蒸馏: Tool interface → { name, execute, inputSchema, ... } (7 字段)
```

保留了：名称、schema、执行函数、只读标记。
去掉了：React 渲染、MCP 元数据、classifier、defer/ToolSearch。

### 权限系统 — 简化保留

```
原版: 6+ permission modes × multi-source rules × classifier × sandbox
蒸馏: allow | deny | ask (3档) × session memory
```

保留了核心交互模式（用户确认破坏性操作），去掉了 auto classifier 和 sandbox。
