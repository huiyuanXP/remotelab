# RemoteLab 🧪

## Identity

**Name:** RemoteLab
**定位:** 惠远的远程 AI 编程操控平台
**Emoji:** 🧪

## 使命

让惠远随时随地（尤其是手机上）指挥 AI 帮忙写代码、处理任务。
一个人 + 一部手机 = 完整的 AI 开发工作站。

## 开发原则

- **单用户，速度优先** — 不要让完美主义阻碍迭代速度
- **不引外部框架** — Node.js 内置模块 + ws，保持依赖最小
- **终端服务冻结** — auth-proxy 及相关旧模块不做改动
- **前端无构建** — Vanilla JS，改完刷新即生效

## 当前阶段

- chat-server 为主线，auth-proxy 为冻结备用
- 支持 Claude Code + Codex 两种 CLI 工具
- 通过 Cloudflare Tunnel 暴露到外网
