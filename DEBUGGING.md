# RemoteLab Debugging Guide

Quick reference for diagnosing issues with the scheduler, workflows, and MCP tools.

---

## Log Files

| Log | Path | Contents |
|-----|------|----------|
| **Chat server stdout** | `~/.local/share/remotelab/logs/chat-server.log` | `[Scheduler]`, `[Workflow]`, `[router]` tagged messages |
| **Chat server stderr** | `~/.local/share/remotelab/logs/chat-server.error.log` | Unhandled errors, crash output |
| **MCP server** | stderr → captured by parent process (Claude Code) | `[mcp]` tagged messages |
| **Workflow run meta** | `~/.config/claude-web/workflow-runs/{runId}/meta.json` | Status, steps, error message + stack |
| **Task output** | `~/.config/claude-web/workflow-runs/{runId}/{taskId}.txt` | Full text output of each task |

---

## Common Debug Scenarios

### "A scheduled task didn't fire"

```bash
# 1. Check scheduler is seeing the schedule
grep '\[Scheduler\]' ~/.local/share/remotelab/logs/chat-server.log | tail -20

# 2. Look for the specific schedule ID
grep 'daily-summary' ~/.local/share/remotelab/logs/chat-server.log | tail -10

# 3. Check if schedules.json is valid
cat ~/remotelab/workflows/schedules.json | node -e "process.stdin.pipe(require('stream').Writable({write(c){JSON.parse(c);process.stdout.write('OK\n')}}))"
```

Possible causes:
- `enabled: false` — check schedules.json
- `runCount >= maxRuns` — schedule was auto-deleted after reaching limit
- `runAt` already passed with `lastRun` set — won't re-trigger
- Server was restarted after `runAt` time passed and `lastRun` was already set

---

### "A workflow run failed"

```bash
# 1. Find recent runs
ls -lt ~/.config/claude-web/workflow-runs/ | head -10

# 2. Check the run's status
cat ~/.config/claude-web/workflow-runs/{runId}/meta.json

# 3. See what each task produced (or didn't)
cat ~/.config/claude-web/workflow-runs/{runId}/{taskId}.txt

# 4. Check server log around that time
grep '\[Workflow\]' ~/.local/share/remotelab/logs/chat-server.log | grep {runId}
```

meta.json fields to look at:
- `status`: `running` / `completed` / `failed`
- `error`: short error message
- `errorStack`: full stack trace (if present)
- `failedAt`: timestamp of failure
- `steps.{stepId}.status`: per-step status

---

### "`schedule_message` didn't trigger"

```bash
# 1. Confirm the schedule was registered
grep 'schedule_message' ~/remotelab/workflows/schedules.json
grep 'schedule_message\|msg-' ~/.local/share/remotelab/logs/chat-server.log | tail -10

# 2. Check MCP server log (appears in Claude Code's output for the session that called it)
grep '\[mcp\] schedule_message' ~/.local/share/remotelab/logs/chat-server.error.log
```

Common cause: `delay_ms` was passed but the server restarted before the `setTimeout` fired.
The scheduler reads `runAt` from `schedules.json` on startup, so it should re-arm — verify `lastRun` is still null in the schedule.

---

### "Session isn't receiving the message"

```bash
# Check the target session exists and its status
grep '{sessionId}' ~/.config/claude-web/sessions.json

# Check recent workflow task output for that session
cat ~/.config/claude-web/workflow-runs/{runId}/msg.txt
```

---

## Service Management

```bash
# View live logs
journalctl --user -u remotelab-chat -f

# Or tail the log file directly
tail -f ~/.local/share/remotelab/logs/chat-server.log
tail -f ~/.local/share/remotelab/logs/chat-server.error.log

# Restart the server (e.g. after code changes)
systemctl --user restart remotelab-chat

# Check service status
systemctl --user status remotelab-chat remotelab-proxy remotelab-tunnel
```

---

## Log Tag Reference

| Tag | File | Meaning |
|-----|------|---------|
| `[Scheduler]` | scheduler.mjs | Schedule loading, timing, trigger, maxRuns deletion |
| `[Workflow]` | workflow-engine.mjs | Task execution start/finish, step progress, disposable archive |
| `[router]` | router.mjs | HTTP requests, manual triggers, auth failures |
| `[mcp]` | mcp-server.mjs | Tool calls, session watcher, schedule_message registration |

---

## Key Data Directories

```
~/.config/claude-web/
├── sessions.json                    # All session metadata
├── session-labels.json              # Label assignments
├── workflow-runs/
│   └── {runId}/
│       ├── meta.json                # Run status, error, steps
│       └── {taskId}.txt             # Task output text
└── chat-history/
    └── {sessionId}.json             # Full conversation history

~/remotelab/workflows/
├── schedules.json                   # Active schedules (source of truth)
└── *.json                           # Workflow definitions
```

---

## Useful One-Liners

```bash
# Show all failed workflow runs
for d in ~/.config/claude-web/workflow-runs/*/; do
  status=$(node -e "const m=require('fs').readFileSync('${d}meta.json','utf8');console.log(JSON.parse(m).status)" 2>/dev/null)
  [[ "$status" == "failed" ]] && echo "$d: $status"
done

# Show schedules and their next run
node -e "
const s = JSON.parse(require('fs').readFileSync('workflows/schedules.json','utf8'));
s.schedules.forEach(sc => console.log(sc.id, '| enabled:', sc.enabled, '| runAt:', sc.runAt || sc.cron || 'manual', '| runs:', sc.runCount+'/'+( sc.maxRuns ?? '∞')));
"

# Watch scheduler activity live
journalctl --user -u remotelab-chat -f | grep '\[Scheduler\]'
```
