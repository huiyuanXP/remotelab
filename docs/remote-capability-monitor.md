# Remote Capability Monitor

This monitor is a lightweight product-intelligence watcher for the RemoteLab Live / remote-agent-control surface.

It is meant to answer a narrow question continuously:

- what new signals are appearing around phone-first control of coding agents,
- what are adjacent tools like `Claude Code` and `Codex` shipping,
- and which capability patterns are worth copying into RemoteLab.

## Shared vs Local Split

- Shared logic lives in `scripts/remote-capability-monitor.mjs`
- Machine-local schedule, channels, and source tuning live outside the repo

That keeps the parsing/scoring reusable while preserving operator-specific delivery details as local config.

## Source Types

The script supports:

- `google_news_rss` sources using a search `query`
- `rss` sources using a direct `url`
- `atom` sources using a direct `url`

Each source can define:

- `lookbackHours`
- `maxItems`
- `baseWeight`
- `target`
- `mustMatchAny`
- `mustMatchAll`
- `lowConfidence`

The monitor scores items heuristically for signals like:

- explicit remote-control positioning
- mobile / pocket / browser control
- notifications and alerts
- background / resume / scheduled execution
- approvals / sandboxing
- voice control
- shareable workflow packaging
- live visual feedback

## Outputs

Typical machine-local outputs are:

- state in `~/.config/remotelab/remote-capability-monitor/`
- reports in `~/.remotelab/research/remote-capability-monitor/`
- notifications via the operator's local notifier config

Each run writes:

- a timestamped Markdown report
- a timestamped JSON summary
- `latest.md`
- `latest.json`

## Typical Commands

Run once:

```bash
node scripts/remote-capability-monitor.mjs \
  --config ~/.config/remotelab/remote-capability-monitor/config.json
```

Bootstrap with a wider first-run window, but do not notify or write state:

```bash
node scripts/remote-capability-monitor.mjs \
  --config ~/.config/remotelab/remote-capability-monitor/config.json \
  --bootstrap-hours 336 \
  --dry-run \
  --verbose
```

Force a heartbeat notification from the current state:

```bash
node scripts/remote-capability-monitor.mjs \
  --config ~/.config/remotelab/remote-capability-monitor/config.json \
  --force-notify
```

## Recommended Local Scheduling

On macOS, use a small wrapper under `~/.remotelab/scripts/` plus a `LaunchAgent` that runs every 6 hours.

That local wrapper should:

- set a clean `PATH`
- point to the machine-local config file
- do lock-based de-duplication so overlapping runs do not stack

## Tuning Note

Some competitor names may be ambiguous in public search feeds. When that happens, keep them in a low-confidence bucket and rely on stronger product-specific or official feed sources until the exact site/repo anchor is known.
