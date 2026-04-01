# 源码映射表 (Source Mapping)

> **独家优势**：本项目直接从 Claude Code 真实 TypeScript 源码蒸馏而来。  
> 以下每行展示：`蒸馏结果 → 原始源码文件 (行数)`

## s01 Agent Loop

```
agentLoop()        → claude-code-main/src/query.ts:queryLoop        (1730 lines)
messages[]         → claude-code-main/src/types/messages.ts          (95 lines)
while(true)+break  → query.ts: for(;;) { ... if stop_reason≠tool_use break }
蒸馏比: 1825 lines → ~100 lines  (18:1)
```

## s02 Tools

```
TOOL_HANDLERS      → claude-code-main/src/tools.ts:getAllBaseTools()      (450 lines)
dispatch map       → tools.ts: Map<string, Tool> + buildTool()            (350 lines)
BashTool           → claude-code-main/src/tools/BashTool/BashTool.tsx     (650 lines)
ReadTool           → claude-code-main/src/tools/ReadTool/ReadTool.tsx     (230 lines)
WriteTool          → claude-code-main/src/tools/WriteTool/WriteTool.tsx   (180 lines)
EditTool           → claude-code-main/src/tools/EditTool/EditTool.tsx     (460 lines)
蒸馏比: 2320 lines → ~200 lines  (11.6:1)
```

## s03 TodoWrite

```
TodoWrite tool     → claude-code-main/src/tools/TodoWriteTool/          (210 lines)
todos state        → AppState.todos                                      (45 lines)
render todos       → TodoWriteTool:formatTodos()                        (80 lines)
蒸馏比: 335 lines → ~250 lines  (1.3:1)
```

## s04 Subagents

```
Task tool          → claude-code-main/src/tools/AgentTool/AgentTool.tsx (1397 lines)
isolated msgs[]    → AgentTool: separate QueryEngine per invocation      (200 lines)
depth limit        → AgentTool:MAX_DEPTH = 3                             (15 lines)
Glob tool          → claude-code-main/src/tools/GlobTool/               (280 lines)
Grep tool          → claude-code-main/src/tools/GrepTool/               (220 lines)
蒸馏比: 2112 lines → ~300 lines  (7:1)
```

## s05 Skills

```
loadSkills()       → claude-code-main/src/services/skills/              (620 lines)
loadRules()        → claude-code-main/src/services/prompt/rules.ts      (380 lines)
AGENTS.md/CLAUDE.md→ services/prompt/projectRules.ts                    (290 lines)
system prompt build→ claude-code-main/src/services/prompt/system.ts     (450 lines)
蒸馏比: 1740 lines → ~350 lines  (5:1)
```

## s06 Compact

```
microCompact()     → claude-code-main/src/services/compact/microCompact.ts  (530 lines)
  旧 tool_result 替换为占位符，保留最近 N 个结果
autoCompact()      → claude-code-main/src/services/compact/autoCompact.ts   (351 lines)
  token 估算 + 阈值触发 + 模型生成摘要
compactConversation→ claude-code-main/src/services/compact/compact.ts       (1705 lines)
  磁盘持久化 + 摘要替换 + 转录保存
.transcripts/      → services/compact/transcriptStorage.ts                   (200 lines)
蒸馏比: 2786 lines → ~400 lines  (7:1)
```

## s07 Tasks

```
TaskManager        → claude-code-main/src/utils/tasks.ts                (862 lines)
  create/get/update/list + DAG 依赖管理
task_create tool   → claude-code-main/src/tools/TaskCreateTool/         (138 lines)
task_update tool   → claude-code-main/src/tools/TaskUpdateTool/         (406 lines)
Task 接口          → utils/tasks.ts:TaskSchema                          (50 lines)
blocks/blockedBy   → tasks.ts:clearDependency()                         (80 lines)
.tasks/ 目录       → tasks.ts:TASKS_DIR                                  (30 lines)
蒸馏比: 1566 lines → ~350 lines  (4.5:1)
```

## s08 Background

```
BackgroundManager  → claude-code-main/src/tasks/LocalShellTask/         (522 lines)
  spawn + stdout/stderr 收集 + 退出码检测
background_run     → tools/BashTool:run_in_background                   (80 lines)
notificationQueue  → tasks/BackgroundTaskNotifier                       (120 lines)
drainNotifications → query.ts:injectNotifications()                     (50 lines)
蒸馏比: 772 lines → ~350 lines  (2.2:1)
```

## s09 Teams

```
TeammateManager    → claude-code-main/src/utils/swarm/inProcessRunner.ts (1552 lines)
  spawn / list / 独立 agent loop
MessageBus         → swarm/messages.ts + JSONL inbox                     (280 lines)
team_spawn tool    → tools/TeamCreateTool/                               (240 lines)
.team/config.json  → swarm/teamConfig.ts                                 (120 lines)
.team/inbox/       → swarm/mailbox.ts                                    (180 lines)
蒸馏比: 2372 lines → ~450 lines  (5.3:1)
```

## s10 Protocols

```
ProtocolTracker    → coordinator/coordinatorMode.ts                      (369 lines)
  request_id 关联的请求-响应状态机
shutdown_request   → swarm/shutdownProtocol.ts                          (200 lines)
plan_approval      → swarm/permissionBridge.ts + leaderBridge.ts         (350 lines)
approve/reject     → coordinator:handleApproval()                        (120 lines)
蒸馏比: 1039 lines → ~450 lines  (2.3:1)
```

## s11 Autonomous

```
状态机 WORK→IDLE→  → swarm/autonomousMode.ts                            (480 lines)
  SCAN→CLAIM→WORK
scanUnclaimed()    → utils/tasks.ts:getUnclaimedTasks()                 (60 lines)
claimTask()        → tasks.ts:claimWithLock()                           (120 lines)
  文件锁原子操作防止竞争条件
identity preserve  → services/compact:injectIdentity()                  (45 lines)
idle timeout       → swarm/idleManager.ts                               (90 lines)
蒸馏比: 795 lines → ~500 lines  (1.6:1)
```

## s12 Worktree

```
WorktreeManager    → claude-code-main/src/utils/worktree.ts             (1519 lines)
  create / run / remove / list
worktree_create    → tools/EnterWorktreeTool/                           (127 lines)
  git worktree add -b wt/<name> <path>
worktree_run       → worktree.ts:execInWorktree()                      (80 lines)
worktree_remove    → tools/ExitWorktreeTool/                            (300 lines)
  git worktree remove --force + branch cleanup
task binding       → worktree.ts:bindToTask()                           (60 lines)
EventBus           → .worktrees/events.jsonl 事件日志                    (40 lines)
蒸馏比: 2126 lines → ~550 lines  (3.9:1)
```

## 总计

| 项目 | 原始行数 | 蒸馏行数 | 压缩比 |
|------|---------|---------|--------|
| s01 Agent Loop | 1,825 | ~100 | 18:1 |
| s02 Tools | 2,320 | ~200 | 11.6:1 |
| s03 TodoWrite | 335 | ~250 | 1.3:1 |
| s04 Subagents | 2,112 | ~300 | 7:1 |
| s05 Skills | 1,740 | ~350 | 5:1 |
| s06 Compact | 2,786 | ~400 | 7:1 |
| s07 Tasks | 1,566 | ~350 | 4.5:1 |
| s08 Background | 772 | ~350 | 2.2:1 |
| s09 Teams | 2,372 | ~450 | 5.3:1 |
| s10 Protocols | 1,039 | ~450 | 2.3:1 |
| s11 Autonomous | 795 | ~500 | 1.6:1 |
| s12 Worktree | 2,126 | ~550 | 3.9:1 |
| **合计** | **19,788** | **~4,250** | **4.7:1** |

> 从近 2 万行真实 Claude Code 源码蒸馏为约 4,250 行教学代码，保留所有核心模式。
