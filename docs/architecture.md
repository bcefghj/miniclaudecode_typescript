# miniclaudecode 架构解析

## Claude Code 原版架构

Claude Code 是 Anthropic 的官方 AI 编程助手，采用 TypeScript 构建，核心架构如下：

```
┌──────────────────────────────────────────────────┐
│  CLI 入口 (main.tsx ~4600行)                       │
│  ├── Commander 命令解析                             │
│  ├── 模式判定 (交互/非交互/远程)                      │
│  └── 初始化链 (settings/env/telemetry)              │
├──────────────────────────────────────────────────┤
│  Agent 引擎                                       │
│  ├── QueryEngine.ts (~1295行) — 会话管理            │
│  ├── query.ts (~1730行) — 主循环状态机               │
│  └── query/deps.ts — callModel 依赖注入             │
├──────────────────────────────────────────────────┤
│  API 层                                           │
│  ├── services/api/claude.ts (~3420行)              │
│  ├── 流式/非流式双模式                               │
│  ├── VCR 录制回放                                   │
│  └── 重试/模型回退/空闲看门狗                         │
├──────────────────────────────────────────────────┤
│  工具系统                                          │
│  ├── Tool.ts (~793行) — 类型契约                    │
│  ├── tools.ts (~390行) — 30+ 工具注册表             │
│  ├── toolExecution.ts — 单工具执行                   │
│  ├── toolOrchestration.ts — 并发/串行调度            │
│  └── StreamingToolExecutor.ts — 流式工具执行         │
├──────────────────────────────────────────────────┤
│  权限系统                                          │
│  ├── permissions.ts — 规则匹配                      │
│  ├── 多源规则合并 (user/project/managed/session)     │
│  ├── Auto classifier                              │
│  └── Sandbox 集成                                  │
├──────────────────────────────────────────────────┤
│  UI 层 (React/Ink TUI)                            │
│  └── ~200个组件/屏幕                                │
└──────────────────────────────────────────────────┘
总计: ~512,664 行 TypeScript/TSX
```

## miniclaudecode 蒸馏架构

```
┌──────────────────────────────────────┐
│  入口 (v0-v4, 每个独立可运行)           │
│  └── readline REPL                   │
├──────────────────────────────────────┤
│  Agent 循环 (core/agentLoop.ts)       │
│  └── while → callModel → tools → ↺   │
├──────────────────────────────────────┤
│  API 层 (core/api.ts)                │
│  └── 流式 SDK 调用 + 用量统计          │
├──────────────────────────────────────┤
│  工具系统 (tools/*.ts)                │
│  ├── Bash, Read, Write, Edit         │
│  ├── Glob, Grep                      │
│  └── Tool 接口 (core/types.ts)       │
├──────────────────────────────────────┤
│  权限 (core/permissions.ts)           │
│  └── allow / deny / ask              │
└──────────────────────────────────────┘
总计: ~2,635 行 TypeScript
```

## 核心数据流

```
用户输入
  │
  ▼
┌─────────────┐
│  REPL 入口    │ ← readline / 命令行参数
└──────┬──────┘
       │ messages.push({ role: "user", content })
       ▼
┌─────────────────────────────────────┐
│  Agent Loop (while true)             │
│                                      │
│  1. stream = callModel(messages)     │
│  2. response = await stream          │
│  3. if stop_reason ≠ "tool_use"      │
│     → return text                    │
│  4. for each tool_use:               │
│     a. checkPermission()             │
│     b. tool.execute(input)           │
│     c. messages.push(tool_result)    │
│  5. continue (下一轮)                │
└──────┬──────────────────────────────┘
       │
       ▼
   输出文本给用户
```

## 关键设计决策

### 1. 单模型循环（无规划器/协调器）

Claude Code 的核心也是单模型循环——没有单独的"规划模型"或"协调层"。
这使得系统可调试、可预测：出问题时只需追踪线性的工具调用序列。

### 2. 工具是 Agent 能力的全部来源

Agent 本身不做任何 I/O 操作——所有与外界的交互都通过工具。
这意味着：

- 增加一个工具 = 增加一种能力
- 工具的质量决定 Agent 的质量
- 工具的权限控制 = Agent 的安全边界

### 3. 消息列表是唯一的真相

每一轮的状态都完整编码在 `messages` 数组中。
不存在隐藏状态——你可以在任何时刻序列化 messages 来保存/恢复会话。

### 4. 流式优先

流式输出不只是 UX 优化——它让用户在 Agent 思考时就能看到中间结果，
建立信任并允许及早中断错误方向的探索。
