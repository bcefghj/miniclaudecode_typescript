# s09 Agent团队 — 多Agent协作

![s09 Agent团队](../comics/comic_s09_teams.png)

## 这一节学什么？

**一句话**：s04 的子Agent是"用完就扔"的临时工。s09 的团队成员是**持久存在**的队友，用异步邮箱通信。

就像一个开发团队——队长分配任务，队员各自工作，通过消息沟通。

## 对比 s04 子Agent

| 特性 | s04 子Agent | s09 团队 |
|------|-----------|---------|
| 生命周期 | 调用时创建，完成后销毁 | 持久运行 |
| 通信方式 | 返回值 | 异步邮箱 (JSONL) |
| 并发 | 串行 | 并行 |
| 主Agent阻塞 | 是 | 否 |

## 核心概念

### 消息总线（MessageBus）

```typescript
class MessageBus {
  send(to: string, msg: TeamMessage) {
    // 追加写入 JSONL 文件
    appendFileSync(
      join(INBOX_DIR, `${to}.jsonl`),
      JSON.stringify(msg) + "\n"
    );
  }

  readInbox(name: string): TeamMessage[] {
    const path = join(INBOX_DIR, `${name}.jsonl`);
    const lines = readFileSync(path, "utf-8").trim().split("\n");
    writeFileSync(path, ""); // 读取后清空
    return lines.map((l) => JSON.parse(l));
  }
}
```

**JSONL 格式**：每行一个 JSON 对象，追加写入不会冲突。

文件结构：
```
.team/
├── config.json              ← 团队成员配置
└── inbox/
    ├── lead.jsonl            ← 队长的收件箱
    ├── frontend_dev.jsonl    ← 前端队员的收件箱
    └── tester.jsonl          ← 测试队员的收件箱
```

### 生成团队成员

```typescript
spawn(name: string, role: string, initialTask: string) {
  // 1. 注册成员
  this.config.members.push({ name, role, status: "active" });

  // 2. 发送初始任务
  bus.send(name, {
    type: "task", from: "lead",
    content: initialTask, timestamp: Date.now()
  });

  // 3. 启动成员的独立循环（后台运行）
  this.runTeammateLoop(name, role);
}
```

### 成员循环

每个成员都有自己的 Agent 循环：

```typescript
async runTeammateLoop(name, role) {
  const msgs = [];       // 独立的对话历史
  for (let turn = 0; turn < 30; turn++) {
    const inbox = bus.readInbox(name);  // 读收件箱
    if (inbox.length > 0) {
      msgs.push({ role: "user", content: inboxText });
    }
    // 调用模型，执行工具...
    // 完成后发送结果给队长
    bus.send("lead", { type: "result", from: name, content: text });
  }
}
```

### 队长轮询

```typescript
async function agentLoop(messages) {
  for (let turn = 0; turn < 50; turn++) {
    // 每轮检查队长收件箱
    const inbox = bus.readInbox("lead");
    if (inbox.length > 0) {
      messages.push({
        role: "user",
        content: `[Team messages]\n${inboxText}`
      });
    }
    // ... 正常循环 ...
  }
}
```

## 工作流程

```
1. 用户 → 队长："实现一个登录功能"
2. 队长 → team_spawn("前端开发", "做登录页面")
         → team_spawn("测试", "写测试用例")
3. 前端开发 ← 收到任务，开始工作
   测试     ← 收到任务，开始工作
4. 前端开发 → 队长："登录页面做好了"
   测试     → 队长："测试用例写好了"
5. 队长 → 用户："全部完成！"
```

## 源码映射

| 蒸馏版 | Claude Code 原版 | 原始行数 |
|--------|-----------------|---------|
| `TeammateManager` | `swarm/inProcessRunner.ts` | 1,552 行 |
| `MessageBus` | `swarm/messages.ts + JSONL` | 280 行 |
| `team_spawn` | `TeamCreateTool/` | 240 行 |
| **总计** | | **2,372 → ~450 行 (5.3:1)** |

## 动手试试

```bash
npx tsx src/s09_teams.ts
```

试试：
- `创建两个队友分别负责前端和后端，给他们分配任务`
- 输入 `team` 查看团队成员状态

## 小测验

1. **JSONL 文件为什么"读后清空"？** 不清空会怎样？
2. **如果两个队员同时写同一个文件会怎样？** 需要什么机制？
3. **队员能和队员直接通信吗？** 还是必须通过队长转发？

---

> 下一节：[s10 团队协议](./s10-protocols.md) — 请求-响应的协商机制
