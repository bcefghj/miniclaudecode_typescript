# 架构说明

## Claude Code 原版架构 (512,664 行)

```
claude-code-main/src/
├── query.ts              # 核心循环 (1730 lines) — 调用模型 → 处理工具 → 循环
├── tools.ts              # 工具注册中心 (450 lines)
├── tools/                # 30+ 工具实现 (~15,000 lines total)
│   ├── BashTool/         # 650 lines
│   ├── EditTool/         # 460 lines
│   ├── AgentTool/        # 1397 lines (子Agent)
│   └── ...
├── services/
│   ├── compact/          # 上下文压缩 (3960 lines)
│   │   ├── microCompact.ts
│   │   ├── autoCompact.ts
│   │   └── compact.ts
│   ├── prompt/           # 系统提示构建 (2000+ lines)
│   └── api/              # API 客户端 (3420 lines)
├── utils/
│   ├── tasks.ts          # 任务管理 (862 lines)
│   ├── worktree.ts       # Git Worktree (1519 lines)
│   └── swarm/            # 多Agent协作 (3000+ lines)
│       ├── inProcessRunner.ts  # 进程内运行
│       └── messages.ts         # 消息总线
└── coordinator/          # 协调模式 (369 lines)
```

## miniclaudecode 蒸馏架构 (~4,250 行)

```
src/
├── s01_agent_loop.ts      # while(true) + Bash                     ~100 lines
├── s02_tools.ts           # dispatch map + 4 tools                 ~200 lines
├── s03_todo.ts            # TodoWrite + plan-first                 ~250 lines
├── s04_subagent.ts        # Task tool + isolated messages[]        ~300 lines
├── s05_skills.ts          # SKILL.md + AGENTS.md loading           ~350 lines
├── s06_compact.ts         # micro/auto/manual compaction           ~400 lines
├── s07_tasks.ts           # TaskManager + DAG dependencies         ~350 lines
├── s08_background.ts      # spawn + notification queue             ~350 lines
├── s09_teams.ts           # TeammateManager + JSONL mailbox        ~450 lines
├── s10_protocols.ts       # request-response + protocolTracker     ~450 lines
├── s11_autonomous.ts      # IDLE→SCAN→CLAIM state machine          ~500 lines
└── s12_worktree.ts        # WorktreeManager + EventBus             ~550 lines
```

## 核心数据流

```
用户输入
  │
  ▼
┌──────────────┐     ┌──────────────┐
│ System Prompt │ ──→ │ Claude API   │
│ + Skills     │     │ (streaming)  │
│ + Rules      │     └──────┬───────┘
└──────────────┘            │
                            ▼
                    ┌───────────────┐
                    │ stop_reason?  │
                    └───────┬───────┘
                    ┌───────┼───────┐
                    │               │
              tool_use          end_turn
                    │               │
                    ▼               ▼
            ┌──────────────┐   输出文本
            │ Dispatch Map │   结束循环
            │ tool → handler│
            └──────┬───────┘
                   │
         ┌─────────┼─────────────┐
         │         │             │
     直接执行    子Agent       后台执行
    (Bash/Read  (独立msgs[])  (spawn)
     /Write/    返回摘要      通知队列
     Edit)                   └──→ 注入
         │         │             │
         └─────────┼─────────────┘
                   │
                   ▼
         tool_result → messages[]
                   │
           ┌───────┴────────┐
           │ microCompact   │ Layer 1: 替换旧结果
           │ autoCompact    │ Layer 2: 超阈值摘要
           │ manualCompact  │ Layer 3: 用户触发
           └───────┬────────┘
                   │
                   ▼
              回到循环顶部
```

## 多 Agent 架构 (s09-s12)

```
                    ┌─────────┐
                    │  Lead   │
                    │ Agent   │
                    └────┬────┘
                  ┌──────┼──────┐
          ┌───────┴┐  ┌──┴───┐  ┌┴───────┐
          │Worker 1│  │Worker2│  │Worker 3│
          │  loop  │  │ loop │  │  loop  │
          └───┬────┘  └──┬───┘  └──┬─────┘
              │          │         │
         ┌────┴──────────┴─────────┴────┐
         │        Message Bus           │
         │   .team/inbox/*.jsonl        │
         └────────┬─────────────────────┘
                  │
         ┌────────┴────────────┐
         │    Task Board       │
         │  .tasks/task_*.json │
         │    DAG 依赖图       │
         └────────┬────────────┘
                  │
         ┌────────┴────────────┐
         │   Worktree Pool     │
         │  git worktree add   │
         │  每任务一个隔离目录   │
         └─────────────────────┘
```

## 蒸馏原则

1. **保留模式，移除复杂度**：原版的 try-catch 链、重试、容错有数千行——蒸馏后保留核心模式，用简单 try-catch 替代
2. **合并分层**：原版的 Tool 接口有 checkPermissions/getInputSchema/call 等多个方法——蒸馏为一个 handler 函数
3. **内联依赖**：原版通过 DI 注入 QueryEngine、PermissionManager 等——蒸馏为模块级变量
4. **同文件原则**：每个阶段是一个完整可运行的 .ts 文件，便于理解全局
