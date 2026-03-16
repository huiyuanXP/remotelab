@AGENTS.md

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 产品定位

RemoteLab 是一个让用户通过手机浏览器远程操控 macOS/Linux 上 AI 编程工具（Claude Code、Codex 等）的 Web 应用。核心场景是：用户不在电脑前，但想用手机指挥 AI 帮忙写代码、处理任务。

## 开发命令

```bash
# 启动 chat server（主线服务，端口 7690）
npm run chat
# 或直接：node chat-server.mjs

# 启动 auth-proxy（终端备用服务，端口 7681）—— 已冻结，不做改动
npm start

# 运行测试
node test-chat.mjs
node test-codex-adapter.mjs  # 等多个 test-codex-*.mjs 文件

# 生成 token
node generate-token.mjs

# 生产环境管理（macOS LaunchAgent / Linux systemd）
./start.sh    # 启动所有服务
./stop.sh     # 停止所有服务
./restart.sh  # 重启
./logs.sh     # 查看日志
```

## 架构概览

### 双服务架构（主线 + 备用）

```
手机浏览器 ──HTTPS──→ Cloudflare Tunnel ──→ chat-server (Node.js :7690)  ← 主线
                                          └──→ auth-proxy (Node.js :7681)  ← 冻结备用
```

**chat-server**：WebSocket 实时聊天，spawn CLI 工具子进程，事件广播给浏览器。
**auth-proxy**：通过 ttyd + dtach 暴露终端，仅在 chat server 崩溃时用于应急访问。

### chat server 核心模块（`chat/`）

| 模块 | 职责 |
|------|------|
| `chat/router.mjs` | HTTP 路由：静态资源、API、登录/登出 |
| `chat/ws.mjs` | WebSocket 消息分发（list/create/attach/send/cancel/delete） |
| `chat/session-manager.mjs` | Session CRUD、进程生命周期、事件广播到订阅者 |
| `chat/process-runner.mjs` | spawn CLI 子进程，逐行解析 JSONL 输出，回调事件 |
| `chat/history.mjs` | Session 历史持久化（JSONL，每个 session 一个文件） |
| `chat/normalizer.mjs` | 标准化事件工厂（message/toolUse/toolResult/fileChange/reasoning/status/usage） |
| `chat/summarizer.mjs` | 进程退出后异步调用 Claude 生成 sidebar 摘要 |
| `chat/middleware.mjs` | 认证检查、安全头、登录失败限流 |
| `chat/adapters/claude.mjs` | Claude Code JSONL 输出解析 |
| `chat/adapters/codex.mjs` | Codex CLI JSONL 输出解析，支持 auto-continue |

### 共享模块（`lib/`，两个服务都可用）

| 模块 | 职责 |
|------|------|
| `lib/auth.mjs` | Token/密码验证、Cookie 会话管理 |
| `lib/config.mjs` | 端口、超时、文件路径等环境变量配置 |
| `lib/tools.mjs` | CLI 工具发现（which）、自定义工具注册 |
| `lib/utils.mjs` | 通用工具函数（readBody 等） |

### 消息流（发送一条消息的完整路径）

```
Browser WebSocket ──send──→ ws.mjs
  → session-manager.sendMessage()
    → 保存用户消息到 history，广播 message 事件
    → process-runner.spawnTool() 启动子进程
      → 读取 JSONL，adapter 解析 → onEvent() 回调
        → 追加到 history，广播给所有监听者
  → 进程退出 → 保存 claudeSessionId/codexThreadId（用于下次恢复）
             → 异步触发 summarizer → sidebar-state.json
```

### 前端（Vanilla JS，无框架，无构建）

| 文件 | 用途 |
|------|------|
| `templates/chat.html` | 主界面 HTML 结构（侧边栏 + 聊天区 + 输入区） |
| `static/chat.js` | 前端逻辑：WebSocket 客户端、消息渲染、session 管理、图片上传 |
| `templates/login.html` | 登录页 |

**热重载**：`chat/router.mjs` 每次请求时从磁盘读取 `chat.html`，开发时改 HTML 刷新即生效，JS 同理（浏览器缓存）。

### 数据存储（`~/.config/claude-web/`）

| 文件/目录 | 内容 |
|-----------|------|
| `auth.json` | Token 和密码 hash |
| `chat-sessions.json` | 所有 session 元数据 |
| `chat-history/{id}.jsonl` | 每个 session 的事件历史 |
| `images/` | 用户上传的图片文件 |
| `sidebar-state.json` | 各 session 的 AI 生成进度摘要 |
| `auth-sessions.json` | 浏览器会话 Cookie |

## API 列表（chat server）

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/api/sessions` | 获取所有 sessions |
| POST | `/api/sessions` | 创建 session（body: `{folder, tool, name}`） |
| DELETE | `/api/sessions/{id}` | 删除 session |
| GET | `/api/tools` | 获取可用工具列表 |
| GET | `/api/sidebar` | 获取 sidebar 进度摘要 |
| GET | `/api/autocomplete?q=` | 文件夹路径自动补全 |
| GET | `/api/browse?path=` | 目录浏览 |
| GET | `/api/images/{filename}` | 获取上传的图片 |
| WS | `/ws` | WebSocket（list/create/rename/delete/attach/send/cancel） |

## 添加新工具 Adapter

1. 在 `chat/adapters/` 创建新文件（参考 `claude.mjs` 或 `codex.mjs`）
2. 实现 `parse(line)` 函数，将 JSONL 行转为 normalizer 事件
3. 实现 `buildArgs(prompt, options)` 构建 CLI 命令参数
4. 在 `chat/process-runner.mjs` 中注册新 adapter

## 安全机制

- Token：256-bit 随机 hex，timing-safe 比较
- Cookie：HttpOnly + Secure + SameSite=Strict，默认 24h 过期
- 限流：登录失败指数退避（最长 15min）
- 网络：服务只监听 127.0.0.1，外部通过 Cloudflare Tunnel 访问
- CSP：nonce-based script allowlist（模板用 `{{NONCE}}` 占位符）
- 输入校验：工具命令禁止 shell 元字符，文件夹必须存在

## 平台支持

- **macOS**：LaunchAgent plist + Homebrew 路径（`/opt/homebrew/bin/`）
- **Linux**：systemd user unit + snap 路径（`/snap/bin/`）、`~/.local/bin/`

## 项目原则

1. **终端服务冻结**：`auth-proxy.mjs`、`lib/router.mjs`、`lib/sessions.mjs`、`lib/proxy.mjs` 不做改动。
2. **单用户，速度优先**：不要让完美主义阻碍迭代速度。
3. **不引外部框架**：Node.js 内置模块 + `ws` 包，保持依赖最小。
4. **代码风格**：ES Modules（`.mjs`），模板用 `{{PLACEHOLDER}}` 占位符，nonce 注入防 XSS。
5. **禁止自动执行 `/restart` skill**：调用 restart skill 会通过 systemd 重启 chat-server，导致所有正在运行的 session 和 Claude 子进程被立即终止。**必须先向用户明确确认后才能执行，绝不能自动默认调用。**
