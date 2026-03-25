# Session Main Flow + Context Freshness Next Push

Status: active execution pack as of 2026-03-18

Companion note: `notes/current/capability-first-shipping-plan.md`
Higher-level product operating note: `notes/current/product-mainline.md`

Historical board-first hypothesis: `notes/archive/board-fanout-next-push.md`

## One-line goal

- With the shipped `Board` surface removed, make the next push feel like an AI collaborator that keeps work coherent across multiple sessions, not like a board-shaped shell around chats.

## Product shape for the next push

- The owner can operate RemoteLab cleanly from session-first surfaces after the shipped `Board` surface is removed.
- One manager/control session can take a single user request and fan it out into several focused parallel sessions when useful.
- A new or sibling session can pick up recent relevant context learned elsewhere so the user does not need to restate everything in every chat.
- Imported context stays bounded and inspectable; prefer summaries, refs, and explicit continuation packets over replaying entire transcripts.
- Sessions remain the canonical durable object; any richer workflow surface must be re-earned later as a derived optional layer.

## Demo we should be able to show

1. Open RemoteLab after `Board` has been removed from the active owner flow.
2. Start or continue from a main session, session list, or lightweight dispatcher-style surface.
3. Ask something that assumes recent context from another session, such as “continue the approach we just settled elsewhere and split it into three parallel tasks”.
4. The system can either pull the right recent context automatically or make the linkage explicit in a lightweight way.
5. The manager session can spawn multiple worker sessions and later return a concise aggregation.
6. We can inspect what context each continued or spawned session actually received.

## Scope freeze

### In scope

- Clarifying the owner main flow now that `Board` is gone.
- One-turn multi-session fan-out.
- A minimal cross-session context freshness contract.
- Observability and regressions directly blocking the above.

### Explicitly out of scope

- Re-productizing `Board` as the owner default.
- Introducing a separate durable `Task` or `BoardCard` object.
- A giant always-on global memory system or transcript-sharing layer.
- A broad core-domain refactor pass.
- Provider registry / provider settings UX.
- Full standalone `Control Inbox` productization.

## Concrete slices

### Slice 1 — validate the session-first main flow after board removal

**Outcome**

- The product can be evaluated cleanly now that the current `Board` surface is gone instead of iterating inside it.

**Product rules**

- Session list, active session, or lightweight dispatcher surfaces are acceptable defaults; the shipped board is gone.
- Do not let board-only affordances survive as hidden dependencies for everyday operation.
- If a UI element only exists to serve board-centric thinking, remove it rather than preserving it as a latent constraint.

**Main files**

- `templates/chat.html`
- `static/chat/ui.js`
- `static/chat/compose.js`
- `static/chat/session-state-model.js`

**Acceptance**

- The owner can navigate and operate the main flow after `Board` is removed.
- Deleting the current board does not break core orchestration.
- The interaction model feels clearer, not more constrained.

### Slice 2 — cross-session context freshness contract

**Outcome**

- Multiple sessions can feel connected without collapsing into one unbounded transcript.

**Product rules**

- Optimize for the "I already told you elsewhere" and "keep up with recent updates" cases.
- Reuse bounded summaries, refs, recent-decision packets, or explicit handoff blocks instead of raw transcript replay.
- Make source and freshness visible enough for debugging and operator trust.
- Keep automatic imports conservative until they prove safe.

**Main files**

- `chat/session-manager.mjs`
- `chat/session-continuation.mjs`
- `chat/history.mjs`
- `chat/runs.mjs`

**Acceptance**

- A new or sibling session can receive recent relevant context from related work.
- The imported packet is bounded and explainable.
- The user does not need to restate obvious recent context across every session.

### Slice 3 — one-turn multi-session fan-out

**Outcome**

- One user turn can intentionally create several worker sessions and get a clean orchestration result back.

**Product rules**

- Do not introduce a batch-orchestration object yet.
- Keep spawned sessions operationally independent after spawn.
- Prefer a concise source-session aggregation and normal session-level navigation over one required handoff note per spawned session.
- Prefer reusing the current spawn/delegate primitives over creating a separate orchestration stack too early.

**Main files**

- `chat/session-manager.mjs`
- `chat/router.mjs`
- `cli.js`
- `lib/session-spawn-command.mjs`

**Acceptance**

- Recursive or repeated spawn works end to end.
- Source-session orchestration stays lightweight.
- The source session can return a concise final aggregation.
- Spawned sessions remain independent and bounded.

### Slice 4 — continuation observability and bounded carry validation

**Outcome**

- Multi-session flows are cheap enough and debuggable enough to trust.

**Product rules**

- The important question is not “do we have memory?” but “what did this session actually inherit, from where, and how fresh was it?”
- Keep continuation paths explicit: raw history, same-session summary handoff, prepared branch context, and any new cross-session import packet.
- Treat this as focused enabling work, not a new memory architecture initiative.

**Main files**

- `chat/session-manager.mjs`
- `chat/history.mjs`
- `chat/runs.mjs`

**Acceptance**

- We can tell which continuation path a run used.
- Compaction remains safe and bounded.
- Cross-session imports do not silently drag too much transcript into the prompt.
- Prepared fork-context reuse is trustworthy again.

## High-priority open todo

- This deserves a dedicated design session once the current main-flow discussion stabilizes.
- The central unresolved question is how to deliver a “same friend across many chats” feeling without exploding the context window.
- Open questions:
  - How should related sessions be discovered: explicit linking, recency, shared app/group, manual pickers, or heuristics?
  - What is the minimal reusable unit: summary, decisions, refs, diff since last read, or a prepared context packet?
  - When should RemoteLab auto-import context versus suggest it versus ask the user?
  - How does the operator inspect or trim imported context before it bloats the prompt?
  - How do we avoid turning many bounded sessions into one hidden giant transcript?

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
- Add a dedicated cross-session context-freshness validation once the contract is defined.

## Default decisions unless reality disproves them

- No separate `Task` object this push.
- No heavyweight persistent parent/child graph this push.
- `Board` is removed from the active owner flow for this push.
- Prefer conservative, inspectable context imports over magical always-on sharing.
- `Control Inbox` stays a follow-on layer built on top of the session-first + multi-session contract, not a prerequisite.

## Push gate

- The owner flow is coherent after deleting `Board` from the active surface.
- Cross-session context freshness is demoable in a bounded, inspectable way.
- One-turn multi-session fan-out is demoable end to end.
- Final aggregation is reliable without requiring heavy parent-side handoff UI.
- We can explain how a run got its continuation context.
- The two current red tests above are either green or explicitly judged non-blocking with a clear reason.
