# s06 三层压缩 — 让对话永不中断

![s06 三层压缩](../comics/comic_s06_compact.png)

## 这一节学什么？

**一句话**：对话越长，上下文窗口越满。三层压缩让 Agent 能"忘掉细节、记住要点"，实现无限长对话。

这是 Claude Code 最精妙的设计之一——用户毫无感知，Agent 自动管理记忆。

## 问题

Claude 的上下文窗口有限（200K tokens）。如果你和 Agent 聊了几百轮，对话历史会超出上限导致 API 报错。

## 解决方案：三层压缩

### 第一层：微压缩（microCompact）

**做什么**：把旧的工具调用结果替换成占位符。

```typescript
function microCompact(messages: Anthropic.MessageParam[]): void {
  let toolResultCount = 0;

  // 从后往前数
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    // 只处理 tool_result 类型
    for (const part of msg.content) {
      if (part.type === "tool_result") {
        toolResultCount++;
        // 保留最近 3 个结果，其余截断
        if (toolResultCount > KEEP_RECENT_RESULTS) {
          if (content.length > 100) {
            part.content = `[Previous tool result truncated — was ${content.length} chars]`;
          }
        }
      }
    }
  }
}
```

**效果**：一个 5000 字符的文件读取结果变成 `[Previous tool result truncated — was 5000 chars]`。

**触发时机**：每一轮循环都自动运行。

### 第二层：自动压缩（autoCompact）

**做什么**：当估算 token 数超过阈值，自动触发完整压缩。

```typescript
function estimateTokens(messages: Anthropic.MessageParam[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

async function autoCompact(messages: Anthropic.MessageParam[]): Promise<Anthropic.MessageParam[]> {
  const tokens = estimateTokens(messages);
  if (tokens < COMPACT_THRESHOLD || messages.length < 8) return messages;

  console.log(`[Auto-compact: ~${tokens} tokens → summarizing]`);
  return compactConversation(messages);
}
```

**触发时机**：当 token 估算值超过 80,000。

### 第三层：手动压缩（compactConversation）

**做什么**：
1. 把旧消息保存到磁盘（`.transcripts/` 目录）
2. 用模型生成旧消息的摘要
3. 用摘要替换旧消息，只保留最近 6 条

```typescript
async function compactConversation(messages: Anthropic.MessageParam[]) {
  const keepRecent = messages.slice(-6);     // 保留最近 6 条
  const toSummarize = messages.slice(0, -6); // 其余生成摘要

  // 1. 持久化到磁盘
  for (const msg of toSummarize) {
    appendFileSync(transcriptPath, JSON.stringify(msg) + "\n");
  }

  // 2. 调用模型生成摘要
  const summaryResp = await client.messages.create({
    system: "Summarize this conversation concisely...",
    messages: [{ role: "user", content: JSON.stringify(toSummarize) }],
  });

  // 3. 组装新消息
  return [
    { role: "user", content: `[Conversation compacted]\n## Summary:\n${summaryText}` },
    { role: "assistant", content: "Understood. I have the context..." },
    ...keepRecent,
  ];
}
```

**触发时机**：用户输入 `compact` 或模型调用 Compact 工具。

## 三层协同

```
每轮循环:
  ├── 第一层: microCompact (替换旧结果) ← 总是运行
  ├── 第二层: autoCompact (检查阈值)    ← 超阈值时运行
  └── 第三层: compact (完整压缩)        ← 手动触发
```

## 源码映射

| 蒸馏版 | Claude Code 原版 | 原始行数 |
|--------|-----------------|---------|
| `microCompact()` | `microCompact.ts` | 530 行 |
| `autoCompact()` | `autoCompact.ts` | 351 行 |
| `compactConversation()` | `compact.ts` | 1,705 行 |
| `.transcripts/` | `transcriptStorage.ts` | 200 行 |
| **总计** | | **2,786 → ~400 行 (7:1)** |

## 动手试试

```bash
npx tsx src/s06_compact.ts
```

多聊几轮后，输入 `compact` 看看压缩效果。

## 小测验

1. **为什么保留最近 6 条消息不压缩？** 提示：压缩了会丢失什么？
2. **`estimateTokens` 用 `JSON长度/4` 精确吗？** 实际场景如何改进？
3. **如果压缩摘要本身很长怎么办？**

---

> 下一节：[s07 文件任务图](./s07-tasks.md) — 用 DAG 管理复杂任务依赖
