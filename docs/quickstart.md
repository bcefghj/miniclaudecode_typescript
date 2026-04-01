# 快速开始

## 什么是 miniclaudecode_typescript？

这是一个**教学项目**，把 Claude Code（Anthropic 的 AI 编程助手，50 万行 TypeScript 源码）蒸馏成 12 个循序渐进的小程序，每个只有几百行代码。

**蒸馏**就像把一本 500 页的教科书浓缩成 12 页的笔记——保留核心思想，去掉冗余细节。

![总览](../comics/comic_s00_overview.png)

## 你需要准备什么？

### 基础知识

- 会写基本的 TypeScript / JavaScript（知道什么是函数、数组、对象就行）
- 了解命令行基本操作（cd、ls、npm）
- 有一个 Anthropic API 密钥（[申请地址](https://console.anthropic.com/)）

### 环境要求

- **Node.js** 18+（[下载地址](https://nodejs.org/)）
- **npm**（Node.js 自带）
- **Git**（s12 需要）

## 安装

```bash
# 克隆项目
git clone https://github.com/bcefghj/miniclaudecode_typescript.git
cd miniclaudecode_typescript

# 安装依赖
npm install
```

## 设置 API 密钥

```bash
export ANTHROPIC_API_KEY="sk-ant-你的密钥"
```

## 运行你的第一个 Agent

```bash
npx tsx src/s01_agent_loop.ts
```

你会看到一个命令行提示符 `>`，输入任何问题，Agent 就会帮你执行命令来回答。

试试输入：
```
> 帮我看看当前目录有什么文件
```

Agent 会自动调用 `ls` 命令，然后用中文告诉你结果。

## 12 阶段学习路线

| 阶段 | 学什么 | 一句话总结 | 运行命令 |
|------|--------|-----------|---------|
| s01 | 核心循环 | 一个 while 循环 + 一个 Bash 工具 | `npx tsx src/s01_agent_loop.ts` |
| s02 | 工具系统 | 分发表模式，4 个工具 | `npx tsx src/s02_tools.ts` |
| s03 | 计划 | TodoWrite 先列计划再执行 | `npx tsx src/s03_todo.ts` |
| s04 | 子Agent | 独立上下文的任务委托 | `npx tsx src/s04_subagent.ts` |
| s05 | 技能 | 按需加载 SKILL.md | `npx tsx src/s05_skills.ts` |
| s06 | 压缩 | 三层上下文压缩 | `npx tsx src/s06_compact.ts` |
| s07 | 任务图 | 文件存储 + DAG 依赖 | `npx tsx src/s07_tasks.ts` |
| s08 | 后台 | 非阻塞执行 | `npx tsx src/s08_background.ts` |
| s09 | 团队 | 异步邮箱通信 | `npx tsx src/s09_teams.ts` |
| s10 | 协议 | 请求-响应审批 | `npx tsx src/s10_protocols.ts` |
| s11 | 自主 | 自动认领任务 | `npx tsx src/s11_autonomous.ts` |
| s12 | 隔离 | Git Worktree | `npx tsx src/s12_worktree.ts` |

**建议**：按顺序学习 s01 → s12，每个阶段都在前一个基础上添加新功能。

## 常见问题

### Q: 需要花多少钱？

每次运行会调用 Claude API，费用取决于对话长度。一般调试一个阶段大约花 $0.01-0.10。

### Q: 可以用其他模型吗？

可以！设置环境变量：
```bash
export MINICC_MODEL="claude-haiku-4-20250514"  # 更便宜的模型
```

### Q: s09-s12 的多Agent会不会很贵？

会比单Agent贵，因为多个Agent各自调用API。建议先用 s01-s08 学习基础，s09-s12 理解概念即可。

---

> 准备好了？从 [s01 核心循环](tutorials/s01-agent-loop.md) 开始吧！
