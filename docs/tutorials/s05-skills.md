# s05 技能注入 — 按需加载专业知识

![s05 技能注入](../comics/comic_s05_skills.png)

## 这一节学什么？

**一句话**：不是把所有知识塞进系统提示词，而是按需从文件加载——需要什么技能，加载什么技能。

就像哆啦A梦的百宝袋——不是把所有道具提前拿出来，而是需要的时候才掏出来。

## 核心概念

### 技能（Skills）

技能就是 `SKILL.md` 文件，放在特定目录下：

```
项目根目录/
├── .cursor/skills/
│   └── react/SKILL.md        ← React 开发技能
├── .minicc/skills/
│   └── testing/SKILL.md      ← 测试技能
└── skills/
    └── deploy/SKILL.md        ← 部署技能
```

每个 `SKILL.md` 包含该领域的最佳实践、注意事项、代码模板等。

### 规则（Rules）

规则是项目级的约定，从这些文件加载：
- `AGENTS.md` — Agent 行为规则
- `CLAUDE.md` — Claude 专用配置
- `.cursor/rules/*.md` — Cursor 规则
- `.minicc/rules/*.md` — minicc 规则

### 加载逻辑

```typescript
function loadSkills(): string {
  const dirs = [
    join(process.cwd(), ".cursor", "skills"),
    join(process.cwd(), ".minicc", "skills"),
    join(process.cwd(), "skills"),
  ];
  const skills: string[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { recursive: true })) {
      if (entry.endsWith("SKILL.md")) {
        skills.push(`## Skill: ${entry}\n${readFileSync(join(dir, entry), "utf-8").slice(0, 2000)}`);
      }
    }
  }
  return skills.length > 0
    ? `\n\n# Available Skills\n${skills.join("\n\n")}`
    : "";
}
```

### 构建系统提示词

```typescript
function buildSystemPrompt(): string {
  return `You are minicc, a coding assistant.
Working directory: ${process.cwd()}
Project: ${basename(process.cwd())}

Tools: Bash, Read, Write, Edit, Glob, Grep, TodoWrite, Task
Rules: Read before editing. Use Edit for changes, Write for new files.
${loadRules()}${loadSkills()}`;
}
```

规则和技能被拼接到系统提示词的末尾——模型开始对话前就能看到。

## 为什么不全部放在 system prompt？

1. **token 效率**：不需要的技能不加载，节省上下文空间
2. **可扩展**：加新技能只需放一个文件，不用改代码
3. **项目隔离**：不同项目有不同的技能和规则

## 源码映射

| 蒸馏版 | Claude Code 原版 | 原始行数 |
|--------|-----------------|---------|
| `loadSkills()` | `services/skills/` | 620 行 |
| `loadRules()` | `services/prompt/rules.ts` | 380 行 |
| AGENTS.md 解析 | `projectRules.ts` | 290 行 |
| system prompt | `services/prompt/system.ts` | 450 行 |
| **总计** | | **1,740 → ~350 行 (5:1)** |

## 动手试试

```bash
# 创建一个技能文件
mkdir -p .minicc/skills/demo
echo "# Demo Skill\n当用户问到 demo 相关问题时，始终用中文回答。" > .minicc/skills/demo/SKILL.md

# 运行
npx tsx src/s05_skills.ts
```

启动时会显示是否找到了 Skills 和 Rules。

## 小测验

1. **如果技能文件有 10 万字，会发生什么？** 提示：注意 `.slice(0, 2000)`
2. **技能和规则有什么区别？** 提示：谁是"怎么做"，谁是"必须遵守"？
3. **如何让技能按需加载而不是启动时全部加载？** 提示：可以做成一个工具

---

> 下一节：[s06 三层压缩](./s06-compact.md) — 让对话永不中断的记忆管理
