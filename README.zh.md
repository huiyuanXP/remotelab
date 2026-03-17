# RemoteLab

[English](README.md) | 中文

**面向 AI worker 的移动端 orchestration workbench / control plane。**

让你的手机成为指挥台，让 AI 继续在你自己的 Mac 或 Linux 机器上干活。

RemoteLab 面向这样一种新协作模式：**人不再亲自操作每一步，而是发目标、看进度、做判断，由 AI 在真实电脑上持续执行。** 你可以用手机浏览器去控制 `codex`、`claude`、`cline` 以及兼容的本地工具，而不是把手机硬做成一个缩水版工作站。

![Chat UI](docs/demo.gif)

> 当前基线：`v0.3` —— owner-first 的 session 编排、detached runners、落盘的持久历史、基于 App 的 workflow packaging，以及无构建步骤的移动端 UI。

---

## 给人类看的部分

### 为什么会有 RemoteLab

AI 发展到这个阶段，真正的瓶颈已经不只是“手敲命令够不够快”，而是：**如何同时编排多个长任务线程，却又不把所有上下文都塞在自己脑子里。**

RemoteLab 就是为这个问题来的。它帮助一个 owner：

- 用手机发起并指挥运行在真实机器上的 AI 工作
- 几小时甚至几天后回来时，快速恢复上下文
- 先看到哪里需要自己决策，而不是被迫重读一大堆 execution log
- 把已经验证过的 workflow 沉淀成可复用、可分享的 `App`

如果一定要给它一个更尖锐的定义：RemoteLab 是 AI 超级个体时代的 orchestration workbench。

### RemoteLab 是什么，不是什么

**RemoteLab 是：**

- 一个运行在你自己机器之上的 AI worker control plane
- 一个以单 owner 为中心、强调 durable sessions 与 context recovery 的系统
- 一个把可重复 agent 协作方式沉淀为 `Apps` 的 workflow packaging 层
- 一个面向决策、审批、快速输入与状态查看的轻量移动端界面

**RemoteLab 不是：**

- 终端模拟器
- 移动 IDE
- 通用多用户聊天 SaaS
- 再造一套 `codex` / `claude` 这类本地强执行器的替代品

### 产品语法

当前产品模型刻意保持简单：

- `Session` —— 持久化的工作线程
- `Run` —— 会话内部的一次执行尝试
- `App` —— 启动会话用的可复用 workflow / policy package
- `Share snapshot` —— 不可变的只读会话导出

这些模型背后的架构假设是：

- HTTP 是规范状态路径，WebSocket 只负责提示“有东西变了”
- 浏览器是控制面，不是系统事实来源
- 运行时进程可以丢，持久状态必须落在磁盘上
- 产品默认单 owner，visitor 访问通过 `Apps` 进行 scope 控制
- 前端保持轻量、无框架、移动端友好

### 它为什么手感不一样

RemoteLab 在几个点上是刻意有立场的：

- **强调编排，不镜像桌面。** 手机是用来指挥工作的，不是为了假装自己是一台小电脑。
- **强调上下文恢复，不堆原始日志。** 比起终端连续性，durable session 更重要。
- **强调 workflow packaging，不只是分享 prompt。** `App` 不是一段复制粘贴文本，而是一种可复用的工作形态。
- **强调接入强执行器，而不是重造执行器。** RemoteLab 负责编排 `codex`、`claude` 这类工具，而不是试图替代它们。

### 你现在可以做什么

- 用手机发消息，让 agent 在真实机器上执行
- 浏览器断开后依然保留持久化历史
- 在控制面重启后恢复长时间运行的工作
- 让 agent 自动生成会话标题和侧边栏分组
- 直接往聊天里粘贴截图
- 界面自动跟随系统亮色 / 暗色外观
- 生成不可变的只读分享快照
- 用 App 链接做 visitor 范围内的入口流转

### Provider 说明

- RemoteLab 现在把 `Codex`（`codex`）作为默认内置工具，并放到选择器最前面。
- 这背后是明确的产品边界：RemoteLab 要做的是接入本地最强执行器，而不是再套一层更重的 UI 去重写它们。
- 对这种自托管控制面来说，API key / 本地 CLI 风格的集成通常比基于消费级登录态的远程封装更稳妥。
- `Claude Code` 依然可以在 RemoteLab 里使用；其他兼容的本地工具也可以接入，前提是它们的认证方式和服务条款适合你的实际场景。
- 实际风险通常来自底层提供商的认证方式和服务条款，而不只是某个 CLI 的名字本身。是否接入、是否继续用，请你自行判断。

### 5 分钟配置完成——直接交给 AI

最快的方式仍然是：把一段 setup prompt 粘贴给部署机器上的 Codex、Claude Code 或其他靠谱的 coding agent。它可以自动完成绝大多数步骤，只会在 Cloudflare 登录这类真正需要人工参与的地方停下来（仅当你选择 Cloudflare 模式时）。

这个仓库里的配置类和功能接入类文档都按同一个原则来写：人只需要把 prompt 发给自己的 AI agent，Agent 会尽量在最开始一轮把需要的上下文都问清楚，然后后续流程都留在那段对话里，只有明确标记为 `[HUMAN]` 的步骤才需要人离开对话手工处理。

最优雅的模式就是一次性交接：Agent 先一轮收齐信息，人回一次；之后 Agent 自己连续完成剩余工作，除非真的需要人工授权、浏览器操作、校验确认或最终验收。

**粘贴前的前置条件：**
- **macOS**：已安装 Homebrew + Node.js 18+
- **Linux**：Node.js 18+
- 至少安装了一个 AI 工具（`codex`、`claude`、`cline` 或兼容的本地工具）
- **网络**（二选一）：
  - **Cloudflare Tunnel**：域名已接入 Cloudflare（[免费账号](https://cloudflare.com)，域名约 ¥10–90/年，可从 Namecheap 或 Porkbun 购买）
  - **Tailscale**：[个人使用免费](https://tailscale.com)——手机和开发机都安装 Tailscale 并加入同一个 tailnet，无需域名

**把这段 prompt 粘贴到 Codex 或其他 coding agent：**

```text
我想在这台机器上配置 RemoteLab，这样我就能用手机远程控制 AI 编程工具了。

网络模式：[cloudflare | tailscale]

# Cloudflare 模式：
我的域名：[YOUR_DOMAIN]
我想用的子域名：[SUBDOMAIN]

# Tailscale 模式：
（无需额外配置——手机和开发机都已安装 Tailscale 并在同一个 tailnet 中。）

请按照本仓库 docs/setup.md 中的完整安装指南一步步来。
把 docs/setup.md 当作配置契约，而不是让我手工抄步骤。
后续流程都留在这个对话里。
开始执行前，请先用一条消息把缺少的上下文一次性问全，让我集中回复一次。
能自动完成的步骤请直接做。
我回复后，请持续自主执行；只在真的遇到 [HUMAN] 步骤、授权确认或最终完成时停下来。
停下来时，请明确告诉我具体要做什么，以及我做完后你会怎么验证。
```

如果你想看完整的配置契约和人工节点说明，请直接看 `docs/setup.md`。

### 配置完成后你会得到什么

在手机上打开你的 RemoteLab 地址：
- **Cloudflare**：`https://[subdomain].[domain]/?token=YOUR_TOKEN`
- **Tailscale**：`http://[hostname].[tailnet].ts.net:7690/?token=YOUR_TOKEN`

![Dashboard](docs/new-dashboard.png)

- 新建一个本地 AI 工具会话，默认优先使用 Codex
- 默认从 `~` 开始，也可以让 agent 切到其他仓库路径
- 发送消息时，界面会在后台不断重新拉取规范 HTTP 状态
- 关掉浏览器后再回来，不会丢失会话线程
- 生成不可变的只读会话分享快照
- 按需配置基于 App 的 visitor 流程和推送通知

### 日常使用

配置完成后，服务可以在开机时自动启动（macOS LaunchAgent / Linux systemd）。你平时只需要在手机上打开网址。

```bash
remotelab start
remotelab stop
remotelab restart chat
```

## 文档地图

如果你是经历了很多轮架构迭代后重新回来看，现在推荐按这个顺序读：

1. `README.md` / `README.zh.md` —— 产品概览、安装路径、日常操作
2. `docs/project-architecture.md` —— 当前已落地架构和代码地图
3. `docs/README.md` —— 文档分层和同步规则
4. `notes/current/core-domain-contract.md` —— 当前领域模型 / 重构基线
5. `notes/README.md` —— 笔记分桶和清理规则
6. `docs/setup.md`、`docs/external-message-protocol.md`、`docs/creating-apps.md`、`docs/feishu-bot-setup.md` 这类专题文档

---

## 架构速览

RemoteLab 当前的落地架构已经稳定在：一个主 chat 控制面、detached runners，以及落盘的持久状态。

| 服务 | 端口 | 职责 |
|------|------|------|
| `chat-server.mjs` | `7690` | 生产可用的主 chat / 控制面 |

```
手机浏览器                             手机浏览器
   │                                      │
   ▼                                      ▼
Cloudflare Tunnel                    Tailscale (VPN)
   │                                      │
   ▼                                      ▼
chat-server.mjs (:7690)             chat-server.mjs (:7690)
   │
   ├── HTTP 控制面
   ├── 鉴权 + 策略
   ├── session/run 编排
   ├── 持久化历史 + run 存储
   ├── 很薄的 WS invalidation
   └── detached runners
```

当前最重要的架构规则：

- `Session` 是主持久对象，`Run` 是它下面的执行对象
- 浏览器状态始终要回收敛到 HTTP 读取结果
- WebSocket 是无效化通道，不是规范消息通道
- 之所以能在控制面重启后恢复活跃工作，是因为真正的状态在磁盘上
- 开发 RemoteLab 自身时，`7690` 就是唯一默认 chat/control plane；现在依赖干净重启后的恢复能力，而不是常驻第二个验证服务

完整代码地图和流程拆解请看 `docs/project-architecture.md`。

外部渠道接入的规范契约请看 `docs/external-message-protocol.md`。

---

## CLI 命令

```text
remotelab setup                运行交互式配置向导
remotelab start                启动所有服务
remotelab stop                 停止所有服务
remotelab restart [service]    重启：chat | tunnel | all
remotelab chat                 前台运行 chat server（调试用）
remotelab generate-token       生成新的访问 token
remotelab set-password         设置用户名和密码登录
remotelab --help               显示帮助
```

## 配置项

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CHAT_PORT` | `7690` | Chat server 端口 |
| `CHAT_BIND_HOST` | `127.0.0.1` | Chat server 监听地址（`127.0.0.1` 用于 Cloudflare / 仅本机访问，`0.0.0.0` 用于 Tailscale 或局域网访问） |
| `SESSION_EXPIRY` | `86400000` | Cookie 有效期（毫秒，24h） |
| `SECURE_COOKIES` | `1` | Tailscale 或本地 HTTP 访问时设为 `0`（无 HTTPS） |

## 常用文件位置

| 路径 | 内容 |
|------|------|
| `~/.config/remotelab/auth.json` | 访问 token + 密码哈希 |
| `~/.config/remotelab/auth-sessions.json` | Owner / visitor 登录会话 |
| `~/.config/remotelab/chat-sessions.json` | Chat 会话元数据 |
| `~/.config/remotelab/chat-history/` | 每个会话的事件存储（`meta.json`、`context.json`、`events/*.json`、`bodies/*.txt`） |
| `~/.config/remotelab/chat-runs/` | 持久化 run manifest、spool 输出和最终结果 |
| `~/.config/remotelab/apps.json` | App 模板定义 |
| `~/.config/remotelab/shared-snapshots/` | 不可变的只读会话分享快照 |
| `~/.remotelab/memory/` | pointer-first 启动时使用的机器私有 memory |
| `~/Library/Logs/chat-server.log` | Chat server 标准输出 **(macOS)** |
| `~/Library/Logs/cloudflared.log` | Tunnel 标准输出 **(macOS)** |
| `~/.local/share/remotelab/logs/chat-server.log` | Chat server 标准输出 **(Linux)** |
| `~/.local/share/remotelab/logs/cloudflared.log` | Tunnel 标准输出 **(Linux)** |

## 安全

- **Cloudflare 模式**：通过 Cloudflare 提供 HTTPS（边缘 TLS，机器侧仍是本地 HTTP）；服务只绑定 `127.0.0.1`
- **Tailscale 模式**：流量由 Tailscale 的 WireGuard mesh 加密；服务绑定 `0.0.0.0`（所有接口），因此端口也可从局域网/公网访问——在不可信网络中，建议配置防火墙将 `7690` 端口限制为 Tailscale 子网（如 `100.64.0.0/10`）
- `256` 位随机访问 token，做时序安全比较
- 可选 scrypt 哈希密码登录
- `HttpOnly` + `Secure` + `SameSite=Strict` 的认证 cookie（Tailscale 模式下关闭 `Secure`）
- 登录失败按 IP 限流，并做指数退避
- 默认服务只绑定 `127.0.0.1`，不直接暴露到公网；如需局域网访问，设置 `CHAT_BIND_HOST=0.0.0.0`
- 分享快照是只读的，并与 owner 聊天面隔离
- CSP 头使用基于 nonce 的脚本白名单

## 故障排查

**服务启动失败**

```bash
# macOS
tail -50 ~/Library/Logs/chat-server.error.log

# Linux
journalctl --user -u remotelab-chat -n 50
tail -50 ~/.local/share/remotelab/logs/chat-server.error.log
```

**DNS 还没解析出来**

配置完成后等待 `5–30` 分钟，再执行：

```bash
dig SUBDOMAIN.DOMAIN +short
```

**端口被占用**

```bash
lsof -i :7690
```

**重启单个服务**

```bash
remotelab restart chat
remotelab restart tunnel
```

---

## License

MIT
