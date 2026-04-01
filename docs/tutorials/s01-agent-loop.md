# s01 核心循环 — 一切的起点

![s01 核心循环](../../comics/comic_s01_agent_loop.png)

## 这一节学什么？

**用最简单的话说**：AI Agent 就是一个"死循环"——不断地问模型、执行工具、再问模型，直到模型说"我搞定了"。

你可能以为 Claude Code 这种 50 万行代码的系统很复杂。但它的核心？其实就是一个 `while(true)` 循环。

本节只用 **约 100 行 TypeScript**，就能做出一个能执行 Shell 命令的 AI Agent。

## 核心概念

### 什么是 Agent？

Agent 不是一个普通的聊天机器人。普通聊天机器人就是"你问我答"。Agent 多了一个能力：**它可以使用工具**。

比如你说"帮我看看当前目录有什么文件"，Agent 会：
1. 理解你的意思
2. 决定调用 `ls` 命令
3. 拿到结果
4. 把结果用人话告诉你

### 核心循环流程

```
用户输入 → while(true) {
  ① 调用模型（发送对话历史 + 可用工具）
  ② 模型返回：
     - 如果是文字 → 打印给用户，结束循环
     - 如果是工具调用 → 执行工具，把结果加入对话历史
  ③ 继续循环
}
```

## 代码逐行讲解

### 1. 初始化

```typescript
import Anthropic from "@anthropic-ai/sdk";
import { execSync } from "child_process";
import * as readline from "readline";

const client = new Anthropic();
const MODEL = process.env.MINICC_MODEL || "claude-sonnet-4-20250514";
```

- `@anthropic-ai/sdk`：官方 SDK，帮你调用 Claude API
- `execSync`：Node.js 内置的"执行 Shell 命令"函数
- `readline`：Node.js 内置的命令行输入工具
- `client`：API 客户端实例，它会自动读取环境变量 `ANTHROPIC_API_KEY`

### 2. 定义唯一的工具：Bash

```typescript
const TOOLS: Anthropic.Tool[] = [
  {
    name: "Bash",
    description: "Run a shell command and return stdout/stderr.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The bash command to execute" },
      },
      required: ["command"],
    },
  },
];
```

这就是"告诉模型你有什么工具可以用"。格式遵循 JSON Schema。模型会根据这个描述来决定什么时候调用什么工具。

### 3. 工具执行函数

```typescript
function runBash(command: string): string {
  try {
    return execSync(command, {
      encoding: "utf-8",
      timeout: 30_000,     // 超时 30 秒
      cwd: process.cwd(),  // 在当前目录执行
    }).slice(0, 10_000);   // 最多返回 1 万字符
  } catch (e: unknown) {
    const err = e as { stderr?: string; message?: string };
    return `Error: ${err.stderr || err.message}`;
  }
}
```

注意几个安全措施：
- **超时保护**：防止命令卡住
- **输出截断**：防止返回太多内容浪费 token
- **错误捕获**：命令失败也不会崩溃

### 4. 核心：Agent 循环

```typescript
async function agentLoop(query: string) {
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: query },
  ];

  while (true) {
    // ① 调用模型
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: "You are a coding assistant. Use the Bash tool to help the user.",
      tools: TOOLS,
      messages,
    });

    // 把模型的回复加入对话历史
    messages.push({ role: "assistant", content: response.content });

    // ② 检查退出条件：模型没有调用工具 → 结束
    if (response.stop_reason !== "tool_use") {
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      console.log(text);
      return;
    }

    // ③ 执行工具，收集结果
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        const { command } = block.input as { command: string };
        console.log(`$ ${command}`);
        const output = runBash(command);
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: output,
        });
      }
    }
    // 把工具结果加入对话历史
    messages.push({ role: "user", content: results });
    // 回到循环顶部 → 继续调用模型
  }
}
```

**这就是整个 Agent 的核心！** 所有后续的 s02-s12 都是在这个循环基础上叠加功能。

### 关键理解

`messages` 数组就像一个"对话记忆"：
```
[user] "帮我看看目录"
[assistant] tool_use: Bash({command: "ls"})
[user] tool_result: "file1.ts\nfile2.ts"
[assistant] "当前目录有 file1.ts 和 file2.ts 两个文件"
```

每一轮循环，模型都能看到完整的对话历史，包括之前所有的工具调用和结果。

## 源码映射

| 蒸馏版 | Claude Code 原版 | 原始行数 |
|--------|-----------------|---------|
| `agentLoop()` | `query.ts:queryLoop` | 1,730 行 |
| `messages[]` | `types/messages.ts` | 95 行 |
| `while(true)+break` | `for(;;) { if stop_reason≠tool_use break }` | — |
| **总计** | | **1,825 → ~100 行 (18:1)** |

## 动手试试

```bash
# 安装依赖
cd miniclaudecode_typescript
npm install

# 设置 API Key
export ANTHROPIC_API_KEY="你的密钥"

# 运行 s01
npx tsx src/s01_agent_loop.ts
```

然后试试输入：
- `帮我看看当前目录有什么文件`
- `创建一个 hello.txt 文件，内容写 Hello World`
- `查看系统信息`

## 小测验

1. **如果模型永远不停止调用工具会怎样？** 提示：看看循环有没有最大次数限制？
2. **为什么 `tool_result` 要放在 `role: "user"` 里？** 提示：想想 Claude API 的消息格式要求。
3. **如果把 `timeout: 30_000` 去掉，可能会发生什么？**

---

> 下一节：[s02 工具系统](./s02-tools.md) — 从 1 个工具到 4 个工具，学习分发表模式
