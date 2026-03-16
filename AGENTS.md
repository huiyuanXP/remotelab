# AGENTS.md — RemoteLab

## 启动协议（每次 session 开始时执行）

### Step 1 — 读共享 Profile

| 文件 | 内容 | 必读？ |
|------|------|--------|
| `~/.huiyuanclaw/USER.md` | 惠远是谁、目标、协作风格 | ✅ 必读 |
| `~/.huiyuanclaw/MEMORY.md` | 全局长期记忆 | 有则读 |
| `~/.huiyuanclaw/memory/<今天>.md` | 近期全局日志 | 有则读 |

### Step 2 — 读本 Workspace 的身份与工具

| 文件 | 内容 |
|------|------|
| `SOUL.md`（本目录） | RemoteLab 的身份定位与开发原则 |

> 公用工具库参见 `~/.huiyuanclaw/TOOLS.md`。

### Step 3 — 读本 Workspace 的 CLAUDE.md

### Step 4 — 读本 Workspace 的近期日志

`memory/<今天>.md` 和 `memory/<昨天>.md`（如有）

---

## 工具查找协议

1. `~/.huiyuanclaw/TOOLS.md` — 公用工具库
2. **没找到** → 告诉惠远需要什么工具，请他帮忙找或安装

---

## 记忆写入规则

- **日常对话与执行细节** → `memory/YYYY-MM-DD.md`（本目录）
- **重要决策 / 跨 workspace 事件** → 同时写入 `~/.huiyuanclaw/memory/YYYY-MM-DD.md`
- **长期重要信息** → 更新 `~/.huiyuanclaw/MEMORY.md`

---

## RemoteLab 专属规则

- 这是 **RemoteLab 产品 workspace**，负责 RemoteLab 平台自身的开发与维护
- 核心场景：手机远程操控 AI 编程工具（Claude Code、Codex 等）
- **Red Lines:** 不外泄私人数据；`trash` > `rm`；发送到外部前先确认
- **禁止自动执行 restart**：重启会终止所有运行中的 session，必须先确认

## Workspace 地图

| Workspace | 路径 | 职责 |
|-----------|------|------|
| RLOrchestrator | ~/RLOrchestrator | 主 orchestrator，编排调度 |
| ResearchCenter | ~/ResearchCenter | 研究与知识沉淀 |
| remotelab | ~/remotelab | RemoteLab 平台开发（本 workspace） |
| skiplec | ~/skiplec | SkipLec 产品开发 |
