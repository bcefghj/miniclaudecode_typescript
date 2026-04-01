# 架构说明

> 把 50 万行的大象装进 4000 行的冰箱里——来看看怎么做到的。

![总览](../comics/comic_s00_overview.png)

## 白话版：Claude Code 是怎么工作的？

想象你雇了一个超级聪明的助手（AI模型）来帮你编程：

1. **你说**："帮我修复这个 bug"
2. **助手想**：我需要先看看代码 → 调用 Read 工具
3. **系统执行** Read 工具，把代码给助手看
4. **助手想**：找到 bug 了，需要改这里 → 调用 Edit 工具
5. **系统执行** Edit 工具，修改文件
6. **助手说**："搞定了！这是我做的修改…"

这个过程就是一个**循环**——不断地"想→用工具→看结果→再想"，直到问题解决。

Claude Code 的 50 万行代码，本质上就是让这个循环跑得更好、更安全、更智能。

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

## 白话版：单 Agent 的数据流

用最简单的话解释数据流图：

1. **用户输入** → 变成一条消息
2. **系统提示词 + 技能 + 规则** → 告诉 AI "你是谁、能做什么"
3. **调用 Claude API** → AI 看了所有消息，决定做什么
4. **AI 有两个选择**：
   - "我要用工具" → 查分发表找到对应的处理函数去执行
   - "我说完了" → 输出文字，循环结束
5. **工具结果** → 加入消息历史
6. **三层压缩** → 旧消息太多就自动压缩
7. **回到步骤 3** → 继续循环

## 白话版：多 Agent 的架构

![Agent团队](../comics/comic_s09_teams.png)

就像一个开发团队：
- **队长（Lead Agent）**：接收用户需求，分配任务给队员
- **队员（Worker）**：各自独立工作，通过"邮箱"（JSONL 文件）互相通信
- **任务板（Task Board）**：`.tasks/` 目录，记录所有任务的状态和依赖关系
- **独立工位（Worktree）**：每个队员在自己的 Git 工作目录里改代码，互不干扰

## 蒸馏原则

1. **保留模式，移除复杂度**：原版的 try-catch 链、重试、容错有数千行——蒸馏后保留核心模式，用简单 try-catch 替代
2. **合并分层**：原版的 Tool 接口有 checkPermissions/getInputSchema/call 等多个方法——蒸馏为一个 handler 函数
3. **内联依赖**：原版通过 DI 注入 QueryEngine、PermissionManager 等——蒸馏为模块级变量
4. **同文件原则**：每个阶段是一个完整可运行的 .ts 文件，便于理解全局
