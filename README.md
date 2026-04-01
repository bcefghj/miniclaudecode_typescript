# miniclaudecode_typescript

> Claude Code 500,000+ 行 TypeScript 蒸馏为 12 个渐进式阶段 — 从一个 while 循环到多 Agent 团队

[![TypeScript](https://img.shields.io/badge/TypeScript-100%25-blue)](https://www.typescriptlang.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Stages](https://img.shields.io/badge/Stages-12-orange)]()

## 这是什么？

这是目前**唯一直接从 Claude Code 真实 TypeScript 源码蒸馏**的教学项目。不是行为推断，不是 Python 翻译，而是拿着 51 万行源码一行行提取核心模式，浓缩为 ~4,250 行可运行的 TypeScript。

```
Claude Code (512,664 行 TS) ──蒸馏──> miniclaudecode (4,250 行 TS)
                                     压缩比 ≈ 120:1
```

## 快速开始

```bash
# 克隆
git clone https://github.com/bcefghj/miniclaudecode_typescript.git
cd miniclaudecode_typescript

# 安装依赖
npm install

# 设置 API Key
export ANTHROPIC_API_KEY="your-key-here"

# 从最简单的开始
npm run s01    # 一个循环 + 一个工具，就这么简单
npm run s02    # 加上 Read/Write/Edit
npm run s03    # 先计划再执行
npm run s04    # 子 Agent 委托
npm run s05    # 技能注入
npm run s06    # 三层上下文压缩
npm run s07    # 文件任务图
npm run s08    # 后台并发
npm run s09    # Agent 团队
npm run s10    # 团队协议
npm run s11    # 自主 Agent
npm run s12    # Git Worktree 隔离
```

## 12 个阶段一览

```
     s01         s02          s03          s04
  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐
  │ 一个循环  │→│ 4个工具  │→│ 任务规划  │→│ 子Agent │
  │ + Bash  │ │ dispatch │ │ TodoWrite│ │ 独立上下文│
  │  ~100行  │ │  ~200行  │ │  ~250行  │ │  ~300行  │
  └─────────┘ └─────────┘ └─────────┘ └─────────┘
       │            │            │            │
     s05         s06          s07          s08
  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐
  │ 技能注入  │→│ 三层压缩  │→│ 文件任务  │→│ 后台并发 │
  │ SKILL.md │ │ compact  │ │ DAG依赖  │ │ spawn   │
  │  ~350行  │ │  ~400行  │ │  ~350行  │ │  ~350行  │
  └─────────┘ └─────────┘ └─────────┘ └─────────┘
       │            │            │            │
     s09         s10          s11          s12
  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐
  │ Agent团队│→│ 团队协议  │→│ 自主Agent│→│ Worktree│
  │ 邮箱通信  │ │ 请求响应  │ │ 自动认领  │ │ Git隔离 │
  │  ~450行  │ │  ~450行  │ │  ~500行  │ │  ~550行  │
  └─────────┘ └─────────┘ └─────────┘ └─────────┘
```

## 对比其他项目

| 特性 | miniclaudecode (本项目) | learn-claude-code | cc-mini | ClaudeLite |
|------|----------------------|-------------------|---------|------------|
| 语言 | **TypeScript** (与原版一致) | Python | TypeScript | Python |
| 阶段数 | **12** | 12 | 1 | 1 |
| 总代码量 | **~4,250 行** | ~3,400 行 | ~800 行 | ~600 行 |
| 源码映射 | **有 (每行标注)** | 无 | 无 | 无 |
| 蒸馏方式 | **真实源码蒸馏** | 行为推断 | 参考文档 | 参考文档 |
| 上下文压缩 | **三层 (micro/auto/manual)** | 双层 | 无 | 无 |
| 文件任务图 | **DAG 依赖** | 有 | 无 | 无 |
| 后台任务 | **spawn + 通知** | 有 | 无 | 无 |
| Agent 团队 | **JSONL 邮箱** | 有 | 无 | 无 |
| 自主认领 | **文件锁 + 状态机** | 有 | 无 | 无 |
| Git Worktree | **隔离执行** | 有 | 无 | 无 |
| 教学漫画 | **哆啦A梦风格** | 无 | 无 | 无 |

## 核心优势

### 1. 从真实源码出发
```
原版: claude-code-main/src/services/compact/compact.ts (1705行)
     ↓ 提取核心模式
蒸馏: src/s06_compact.ts:compactConversation() (~40行)
```
每个阶段都标注了对应的原版文件和行号。详见 [docs/source-mapping.md](docs/source-mapping.md)

### 2. 原生 TypeScript
Claude Code 本身就是 TypeScript 写的。用 TypeScript 蒸馏，类型、模式、API 完全一致。不存在 Python→TS 的翻译偏差。

### 3. 渐进式学习
每个阶段都是独立可运行的文件，从 ~100 行到 ~550 行渐进增长。不需要一次理解全部。

### 4. 漫画教学
每个阶段配套哆啦A梦风格教学漫画，在 `comics/` 目录中。

## 项目结构

```
miniclaudecode_typescript/
├── src/
│   ├── s01_agent_loop.ts     # 一个循环 + Bash
│   ├── s02_tools.ts          # 工具注册 dispatch
│   ├── s03_todo.ts           # TodoWrite 规划
│   ├── s04_subagent.ts       # 子 Agent 委托
│   ├── s05_skills.ts         # 技能注入
│   ├── s06_compact.ts        # 三层上下文压缩
│   ├── s07_tasks.ts          # 文件任务图
│   ├── s08_background.ts     # 后台并发
│   ├── s09_teams.ts          # Agent 团队
│   ├── s10_protocols.ts      # 团队协议
│   ├── s11_autonomous.ts     # 自主 Agent
│   ├── s12_worktree.ts       # Git Worktree 隔离
│   ├── core/                 # 共享核心模块
│   └── tools/                # 共享工具模块
├── comics/                   # 哆啦A梦教学漫画
├── docs/
│   ├── architecture.md       # 架构说明
│   ├── source-mapping.md     # 源码映射表 (独家)
│   ├── distillation-guide.md # 蒸馏方法论
│   └── comparison.md         # 对比分析
├── legacy/                   # 旧版 v0-v4
├── package.json
└── README.md
```

## 学习路径

### 🟢 入门 (s01-s03)

> 理解 AI Agent 的核心循环

- **s01**: 100 行代码，一个 `while(true)` + Bash 工具 = 最简 Agent
- **s02**: 注册 4 个工具到 dispatch map，模型按需调用
- **s03**: 先用 TodoWrite 列出计划，再逐步执行

### 🟡 进阶 (s04-s06)

> 掌握 Agent 的智能扩展

- **s04**: 子 Agent 用独立 `messages[]` 保持主对话干净
- **s05**: 从 `SKILL.md` 和 `AGENTS.md` 按需注入领域知识
- **s06**: 三层压缩让对话无限延续——micro/auto/manual

### 🔴 高级 (s07-s09)

> 构建多 Agent 协作系统

- **s07**: 用 `.tasks/` 目录构建 DAG 任务图，完成自动解锁
- **s08**: 用 `spawn` 在后台跑慢操作，完成后通知 Agent
- **s09**: 团队成员有独立循环和 JSONL 邮箱

### ⚫ 专家 (s10-s12)

> 理解生产级 Agent 系统架构

- **s10**: 请求-响应协议实现关闭、审批等流程
- **s11**: Agent 自动扫描并认领未分配任务
- **s12**: Git Worktree 提供完全隔离的工作目录

## 蒸馏统计

从近 **20,000 行**真实 Claude Code 源码蒸馏为 **~4,250 行**教学代码（压缩比 4.7:1），涵盖 12 个核心子系统。整个 Claude Code（51万行）的核心架构模式都在这里。

## 环境要求

- Node.js 18+
- Anthropic API Key (`ANTHROPIC_API_KEY`)
- Git (s12 需要)
- ripgrep (`rg`, Grep 工具使用, 可选)

## 致谢

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) by Anthropic
- [learn-claude-code](https://github.com/shareAI-lab/learn-claude-code) 启发了渐进式教学结构
- [cc-mini](https://github.com/e10nMa2k/cc-mini), [ClaudeLite](https://github.com/davidweidawang/ClaudeLite) 先行者

## License

MIT
