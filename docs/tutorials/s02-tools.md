# s02 工具系统 — 四个工具搞定 90% 编程任务

![s02 工具系统](../../comics/comic_s02_tools.png)

## 这一节学什么？

**上一节**我们用一个 Bash 工具就能干活了。但只能执行命令，不够优雅。

**这一节**增加到 4 个工具（Bash、Read、Write、Edit），并学习一个重要设计模式：**分发表（Dispatch Map）**。

循环不变，工具随便加——这就是可扩展的秘密。

## 核心概念：分发表

```typescript
type ToolHandler = (input: Record<string, unknown>) => string;

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  Bash: (input) => { /* 执行命令 */ },
  Read: (input) => { /* 读取文件 */ },
  Write: (input) => { /* 写入文件 */ },
  Edit: (input) => { /* 编辑文件 */ },
};
```

**白话解释**：分发表就像一本"电话簿"——模型说"我要用 Read 工具"，我们查电话簿找到 Read 对应的处理函数，然后执行它。

加新工具？往电话簿里加一条就行，循环一行都不用改。

## 四大工具详解

### Bash — 执行命令

和 s01 一样，执行 Shell 命令。这是最灵活的工具。

### Read — 读取文件

```typescript
Read: (input) => {
  const lines = readFileSync(resolve(input.file_path as string), "utf-8").split("\n");
  const start = Math.max(0, ((input.offset as number) ?? 1) - 1);
  const end = input.limit ? start + (input.limit as number) : lines.length;
  return lines.slice(start, end)
    .map((l, i) => `${String(start + i + 1).padStart(6)}|${l}`)
    .join("\n") || "(empty)";
},
```

特点：
- **带行号输出**（`     1|内容`），方便模型定位代码
- 支持 `offset` 和 `limit` 参数，可以只读文件的一部分

### Write — 写入文件

```typescript
Write: (input) => {
  const p = resolve(input.file_path as string);
  const dir = dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(p, input.content as string, "utf-8");
  return `File written: ${p}`;
},
```

特点：**自动创建目录**——如果写 `a/b/c/file.txt`，会自动创建 `a/b/c/`。

### Edit — 查找替换

```typescript
Edit: (input) => {
  const content = readFileSync(p, "utf-8");
  const old = input.old_string as string;
  const count = content.split(old).length - 1;
  if (count === 0) return `Error: old_string not found`;
  if (count > 1) return `Error: found ${count} times — must be unique`;
  writeFileSync(p, content.replace(old, input.new_string as string));
  return `Edited: ${p}`;
},
```

关键约束：**old_string 必须在文件中唯一出现**。这防止了模型修错地方。

## 循环如何分发

```typescript
for (const b of response.content) {
  if (b.type !== "tool_use") continue;
  const input = b.input as Record<string, unknown>;
  // 查分发表 → 执行 → 收集结果
  const handler = TOOL_HANDLERS[b.name];
  const output = handler ? handler(input) : `Unknown tool: ${b.name}`;
  results.push({ type: "tool_result", tool_use_id: b.id, content: output });
}
```

循环逻辑和 s01 完全一样，唯一的变化是用 `TOOL_HANDLERS[b.name]` 查表代替了硬编码。

## 源码映射

| 蒸馏版 | Claude Code 原版 | 原始行数 |
|--------|-----------------|---------|
| `TOOL_HANDLERS` | `tools.ts:getAllBaseTools()` | 450 行 |
| 分发表 | `Map<string, Tool> + buildTool()` | 350 行 |
| Bash | `BashTool.tsx` | 650 行 |
| Read | `ReadTool.tsx` | 230 行 |
| Write | `WriteTool.tsx` | 180 行 |
| Edit | `EditTool.tsx` | 460 行 |
| **总计** | | **2,320 → ~200 行 (11.6:1)** |

## 动手试试

```bash
npx tsx src/s02_tools.ts
```

试试这些输入：
- `读取 package.json 的前 10 行`
- `创建一个 test.ts 文件，写一个 hello world 函数`
- `把 test.ts 里的 hello 改成 hi`

## 小测验

1. **为什么用分发表而不是 if-else？** 提示：如果有 30 个工具呢？
2. **Edit 工具为什么要求唯一匹配？** 提示：如果有 5 处相同代码，改哪个？
3. **如何添加一个新的 "ListDir" 工具？** 需要改几个地方？

---

> 下一节：[s03 先计划再执行](./s03-todo.md) — 用 TodoWrite 给 Agent 加上计划能力
