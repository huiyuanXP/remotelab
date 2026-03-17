# Board + Fan-Out Next Push

Status: active execution pack as of 2026-03-17

Companion note: `notes/current/capability-first-shipping-plan.md`

## One-line goal

- Make the next push feel like an AI orchestration workbench rather than a long-thread chat app.

## Product shape for the next push

- The owner lands in `Board` as the default work overview.
- One manager/control session can take a single user request and fan it out into several focused child sessions.
- The board remains session-derived; there is still no separate durable `Task` object.
- Child sessions stay mostly hidden unless they become actionable, promoted, pinned, or explicitly opened.
- Context carry stays bounded and observable so the fan-out workflow remains cheap, fast, and understandable.

## Demo we should be able to show

1. Open RemoteLab and land on `Board`.
2. Enter one manager-style request such as “把这个需求拆成 3 个并行子任务，并汇总结果”.
3. The manager session spawns multiple child sessions.
4. `Board` shows those sessions in sensible columns like `Active`, `Waiting`, `Open`, `Done`.
5. The parent session receives one visible handoff note per child plus one concise aggregate summary.
6. If one child needs human input, it appears clearly in `Waiting` and can be opened directly from the board.
7. We can inspect how a child or resumed turn got its context: raw history, summary handoff, or prepared branch context.

## Scope freeze

### In scope

- `Board` as the primary owner work surface.
- Session metadata sufficient to drive that board cleanly.
- One-turn multi-session fan-out with visible parent-side orchestration.
- Context carry/cache confirmation for the new workflow.
- Fixing regressions that block the above slices.

### Explicitly out of scope

- Introducing a separate durable `Task` domain model.
- A broad core-domain refactor pass.
- Provider registry / provider settings UX.
- Full standalone `Control Inbox` productization.
- Theme expansion, brand work, or broader UI polish unrelated to board/fan-out.

## Concrete slices

### Slice 1 — `Board v1` becomes the owner default

**Outcome**

- The board is no longer a side tab experiment; it is the normal owner overview.

**Product rules**

- Keep the current board columns: `Active`, `Waiting`, `Open`, `Parked`, `Done`.
- Keep session-derived truth only: card content comes from session metadata and activity, not a new task layer.
- Default child visibility should be conservative: show child sessions when they are waiting on the user, pinned, manually opened, high priority, or otherwise promoted by board rules.

**Main files**

- `templates/chat.html`
- `static/chat/ui.js`
- `static/chat/compose.js`
- `static/chat/session-state-model.js`
- `static/chat/session-http.js`

**Acceptance**

- Owner opens into `Board` by default.
- Board cards show enough truth for daily use: title, time, status, priority, group/project clue, and short description.
- Child sessions do not flood the board by default.
- The board is useful without introducing any extra durable object.

### Slice 2 — board-driving metadata becomes reliably writable

**Outcome**

- The agent can maintain the board through normal session APIs instead of relying on ad hoc side effects.

**Product rules**

- `title`, `group`, and `description` are the minimum presentation contract.
- `workflowState`, `workflowPriority`, and `lastReviewedAt` remain the main explicit board-state controls.
- `project` stays deferred unless `group` proves too weak during actual board usage.

**Main files**

- `chat/router.mjs`
- `chat/session-manager.mjs`
- `chat/summarizer.mjs`

**Acceptance**

- Session APIs can write `group` and `description` directly.
- AI-maintained session presentation becomes straightforward rather than UI-coupled.
- Board updates reflect these writes without inventing a second state model.

### Slice 3 — one-turn multi-session fan-out

**Outcome**

- One user turn can intentionally create several worker sessions and get a clean orchestration result back.

**Product rules**

- Do not introduce a batch-orchestration object yet.
- Keep child sessions operationally independent after spawn.
- Require parent visibility: one handoff note per child, one aggregate result back to the parent.
- Prefer reusing the current spawn/delegate primitives over creating a separate orchestration stack too early.

**Main files**

- `chat/session-manager.mjs`
- `chat/router.mjs`
- `cli.js`
- `lib/session-spawn-command.mjs`

**Acceptance**

- Recursive or repeated spawn works end to end.
- Parent transcript shows visible child handoffs.
- Parent receives a concise final aggregation.
- Child sessions remain independent and bounded.

### Slice 4 — context carry/cache confirmation

**Outcome**

- Fan-out and board workflows are cheap enough and debuggable enough to trust.

**Product rules**

- The important question is not “do we have cache?” but “which continuation path did this run actually use?”
- Keep three paths explicit: raw history, summary handoff, prepared branch context.
- Treat this as focused enabling work, not a new cache architecture initiative.

**Main files**

- `chat/session-manager.mjs`
- `chat/history.mjs`
- `chat/runs.mjs`

**Acceptance**

- We can tell which continuation path a run used.
- Compaction remains safe and bounded.
- Prepared fork-context reuse is trustworthy again.
- Fan-out does not silently drag too much transcript into child prompts.

## Known blocking regressions right now

- `tests/test-http-session-spawn-recursive.mjs` is red; this is the concrete canary for multi-session fan-out.
- `tests/test-session-forking.mjs` is red; this is the concrete canary for prepared fork-context confidence.

## Tests that define “good enough” for the next push

- `tests/test-chat-session-state-model.mjs`
- `tests/test-http-runtime-phase1.mjs`
- `tests/test-http-session-spawn-recursive.mjs`
- `tests/test-session-forking.mjs`
- `tests/test-auto-compaction.mjs`
- `tests/test-http-session-summary-refs.mjs`

## Default decisions unless reality disproves them

- No separate `Task` object this push.
- No heavyweight persistent parent/child graph this push.
- `group` comes before `project`; only add `project` if the board immediately needs it.
- `Control Inbox` stays a follow-on layer built on top of board + fan-out, not a prerequisite.

## Push gate

- `Board` is good enough to operate as the owner default.
- Board-driving metadata is writable through session APIs.
- One-turn multi-session fan-out is demoable end to end.
- Parent-side handoffs and final aggregation are visible and reliable.
- We can explain how a run got its continuation context.
- The two current red tests above are either green or explicitly judged non-blocking with a clear reason.
