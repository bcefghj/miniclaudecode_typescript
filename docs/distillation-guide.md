# 蒸馏指南：从 51 万行到 800 行

## 什么是"蒸馏"？

蒸馏（Distillation）是从大型复杂系统中提取核心模式和本质逻辑的过程。
不是复制代码，而是理解架构意图后用最简方式重新表达。

## 蒸馏步骤

### 第一步：识别核心循环

Claude Code 的心脏是 `query.ts` 中的 `queryLoop` 函数（~1730行）。
去掉所有边缘情况处理，核心只有：

```typescript
// 原版 query.ts 的本质（1730行 → 15行）
while (true) {
  yield { type: 'stream_request_start' };
  for await (const message of callModel(messages, tools)) {
    // 收集 assistant 消息和 tool_use 块
  }
  if (没有 tool_use) return;
  toolResults = await runTools(toolUseBlocks);
  messages = [...messages, ...assistantMessages, ...toolResults];
}
```

**被去掉的内容**：
- GrowthBook 特性开关 (~100行)
- 自动/反应式压缩 (~200行)
- 历史剪切 (HISTORY_SNIP) (~50行)
- 上下文折叠 (CONTEXT_COLLAPSE) (~80行)
- Token 预算续写 (~100行)
- 模型回退 (FallbackTriggeredError) (~150行)
- Stop hooks (~80行)
- 工具使用摘要 (Haiku) (~100行)
- 流式工具执行器集成 (~200行)
- 各种 analytics/telemetry (~300行)

### 第二步：简化 API 层

原版 `services/api/claude.ts`（~3420行）处理：
- 原始 SSE 流解析（避免 O(n^2) JSON 拼接）
- VCR 录制/回放
- Bedrock/Vertex 兼容
- 提示缓存断点策略
- 空闲看门狗
- 非流式回退
- advisor 模型
- 多种 beta 特性

蒸馏版直接使用 SDK 的 `.stream()` 方法（SDK 内部已处理流解析）：

```typescript
// 3420行 → 20行
const stream = client.messages.stream({
  model, max_tokens, system, tools, messages
});
stream.on("text", onText);
return await stream.finalMessage();
```

### 第三步：精简工具类型

原版 `Tool.ts`（~793行）定义了庞大的工具接口，包括：
- React 渲染方法（~15个）
- MCP/LSP 元数据
- Auto classifier 接口
- ToolSearch/defer 机制
- 进度报告系统
- Observable 回填

蒸馏为 5 个字段的接口：

```typescript
interface Tool {
  name: string;
  description: string;
  inputSchema: object;
  isReadOnly?: boolean;
  execute(input): Promise<ToolResult>;
}
```

### 第四步：简化权限

原版权限系统跨越 ~2000 行，包括：
- 6+ 种权限模式
- 多源规则合并（user/project/managed/session/command）
- Auto classifier（AI 判断是否安全）
- 沙箱集成
- 域名/路径白名单

蒸馏为三档决策：
```typescript
function check(tool, input): "allow" | "deny" | "ask"
```

### 第五步：去掉非核心子系统

以下子系统各自数千行，但不影响核心 Agent 功能：

| 去掉的子系统 | 大致行数 | 原因 |
|-------------|---------|------|
| React/Ink TUI | ~50,000 | 用 readline 替代 |
| MCP (Model Context Protocol) | ~30,000 | 扩展协议，非核心 |
| Remote/Bridge | ~20,000 | 远程会话 |
| Coordinator/Swarm | ~15,000 | 多 Agent 编排 |
| Skills/Plugins | ~10,000 | 简化为文件加载 |
| Session/Persistence | ~8,000 | 用 messages 数组 |
| Hooks 系统 | ~5,000 | 简化为权限检查 |
| 遥测/分析 | ~5,000 | 去掉 |
| Vim/Keybindings | ~3,000 | 去掉 |
| Voice/语音 | ~3,000 | 去掉 |

## 蒸馏比例

| 组件 | 原版行数 | 蒸馏行数 | 压缩比 |
|------|---------|---------|--------|
| Agent 循环 | ~1,730 | ~166 | 10:1 |
| API 层 | ~3,420 | ~83 | 41:1 |
| 工具类型 | ~793 | ~59 | 13:1 |
| 工具注册 | ~390 | ~26 | 15:1 |
| 权限系统 | ~2,000 | ~74 | 27:1 |
| 工具实现 | ~5,000+ | ~344 | 15:1 |
| **总计** | **512,664** | **2,635** | **195:1** |

## 保留了什么

1. **Agent 循环模式** — while + callModel + tool_use 判断 + 工具执行
2. **流式输出** — 实时文本流 + 事件驱动
3. **工具注册机制** — 名称 + schema + 执行函数
4. **权限三档决策** — allow / deny / ask
5. **上下文管理** — messages 作为唯一真相 + 压缩
6. **子 Agent** — Task 工具 + 隔离上下文
7. **Todo 系统** — 显式任务规划

## 丢弃了什么

1. UI 渲染层（TUI 组件、对话框、进度条）
2. 扩展协议（MCP、LSP、plugin）
3. 基础设施（远程、VCR、遥测、迁移）
4. 平台特定（sandbox、PowerShell、notebook）
5. 高级特性（KAIROS、BUDDY、Coordinator、Worktree）
