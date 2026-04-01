# s03 先计划再执行 — TodoWrite 计划工具

![s03 先计划再执行](../comics/comic_s03_todo.png)

## 这一节学什么？

**一句话**：给 Agent 一个"待办清单"工具，让它在动手之前先列计划。

没有计划的 Agent 就像没有清单的厨师——可能忘记放盐。TodoWrite 让 Agent 养成"先想后做"的好习惯。

## 核心概念

### Todo 数据结构

```typescript
interface TodoItem {
  id: string;           // 唯一标识，如 "step-1"
  content: string;      // 任务描述
  status: "pending" | "in_progress" | "completed" | "cancelled";
}
let todos: TodoItem[] = [];
```

四种状态：
- `pending` ○ — 还没开始
- `in_progress` ◉ — 正在做
- `completed` ✓ — 做完了
- `cancelled` ✗ — 不做了

### TodoWrite 工具处理器

```typescript
TodoWrite: (input) => {
  const items = input.todos as TodoItem[];
  for (const item of items) {
    const existing = todos.find((t) => t.id === item.id);
    if (existing) {
      // 已存在 → 更新
      existing.content = item.content;
      existing.status = item.status;
    } else {
      // 不存在 → 新建
      todos.push(item);
    }
  }
  return renderTodos();
},
```

**关键设计**：用 `id` 匹配——存在就更新，不存在就新建。模型可以一次性创建多个 todo，也可以逐个更新状态。

### 渲染清单

```typescript
function renderTodos(): string {
  const icons = { pending: "○", in_progress: "◉", completed: "✓", cancelled: "✗" };
  return todos.map((t) =>
    `${icons[t.status]} [${t.status}] ${t.id}: ${t.content}`
  ).join("\n");
}
```

输出效果：
```
○ [pending] step-1: 分析需求
◉ [in_progress] step-2: 编写代码
✓ [completed] step-3: 测试验证
```

## 工具如何改变 Agent 行为

关键在 system prompt：

```typescript
system: "Use TodoWrite to plan complex tasks before starting. Read before editing."
```

加了这句话，模型就会在遇到复杂任务时先列计划，再逐步执行。

## 源码映射

| 蒸馏版 | Claude Code 原版 | 原始行数 |
|--------|-----------------|---------|
| TodoWrite 工具 | `tools/TodoWriteTool/` | 210 行 |
| todos 状态 | `AppState.todos` | 45 行 |
| 渲染 | `formatTodos()` | 80 行 |
| **总计** | | **335 → ~250 行 (1.3:1)** |

## 动手试试

```bash
npx tsx src/s03_todo.ts
```

试试：
- `帮我重构 package.json，加上 build 和 test 脚本`（看看它会不会先列计划）
- 输入 `todos` 可以随时查看当前计划

## 小测验

1. **为什么 todos 存在内存而不是文件？** 提示：这一版够用吗？到了 s07 会怎样？
2. **如果模型不用 TodoWrite 直接开干，会出什么问题？**
3. **如何限制最多只能有一个 `in_progress` 状态的 todo？**

---

> 下一节：[s04 子Agent委托](./s04-subagent.md) — 把复杂任务委托给独立的子Agent
